//! Minimum resolved metadata and deterministic planning for selected-service apply.
//! Full configuration values (including interpolated secrets) never leave validation.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ComposePreparationMode {
    Pull,
    Build,
    None,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposeServiceSelection {
    pub service: String,
    pub preparation: ComposePreparationMode,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeApplyService {
    pub name: String,
    pub image: Option<String>,
    pub build: bool,
    pub profiles: Vec<String>,
    pub preparations: Vec<ComposePreparationMode>,
    pub blocked_reason: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeApplyPreview {
    pub project: ComposeProject,
    pub compose_version: String,
    pub services: Vec<ComposeApplyService>,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComposeApplyWarning {
    pub code: String,
    pub image: String,
    pub services: Vec<String>,
}
#[derive(Clone)]
pub(super) struct ComposeApplyMetadata {
    services: BTreeMap<String, ApplyServiceMetadata>,
}
#[derive(Clone)]
struct ApplyServiceMetadata {
    preview: ComposeApplyService,
    effective_image: String,
    build_tags: BTreeSet<String>,
    build_dependencies: BTreeSet<String>,
}
pub(super) struct ComposeApplyPlan {
    pub selections: Vec<ComposeServiceSelection>,
    pub pull_services: Vec<String>,
    pub build_services: Vec<String>,
    pub apply_services: Vec<String>,
    pub warnings: Vec<ComposeApplyWarning>,
}

pub(super) fn apply_help_supports_flags(help: &str, required: &[&str]) -> bool {
    let tokens: HashSet<_> = help.split_whitespace().collect();
    required.iter().all(|flag| tokens.contains(flag))
}

impl Core {
    pub fn preview_compose_apply(
        &self,
        session_id: &str,
        project_id: &str,
        expected_revision: u64,
    ) -> Result<ComposeApplyPreview> {
        let project = self.registered_compose_project(project_id, expected_revision)?;
        let session = self.active(session_id)?;
        let (input, proofs) = normalize_input(project.input())?;
        let validation = self.compose_validation_guard(session_id)?;
        let validated = self.validate_compose_apply(
            &session,
            input,
            proofs,
            validation.token(),
            Instant::now() + Duration::from_secs(30),
        )?;
        self.active(session_id)?;
        self.registered_compose_project(project_id, expected_revision)?;
        Ok(ComposeApplyPreview {
            project,
            compose_version: validated.compose_version,
            services: validated
                .apply_metadata
                .ok_or_else(|| malformed("Missing Compose apply metadata"))?
                .services
                .into_values()
                .map(|service| service.preview)
                .collect(),
        })
    }
}

// Mirrors Docker's default registry/library/tag naming only. An explicit digest
// makes a tag irrelevant, as in ParseDockerRef. Different digests remain distinct;
// no image-content equivalence is inferred, and tag-only references preserve case.
fn normalized_image(reference: &str) -> Result<String> {
    if reference.is_empty() || reference.len() > 2048 || reference.chars().any(char::is_whitespace)
    {
        return Err(malformed("Compose returned an invalid image reference"));
    }
    let (name, digest) = match reference.split_once('@') {
        Some((name, digest)) if !name.is_empty() && !digest.is_empty() => (name, Some(digest)),
        Some(_) => return Err(malformed("Compose returned an invalid image digest")),
        None => (reference, None),
    };
    let (first, remainder) = name.split_once('/').unwrap_or((name, ""));
    let explicit_registry = !remainder.is_empty()
        && (first.contains('.')
            || first.contains(':')
            || first == "localhost"
            || first.chars().any(char::is_uppercase));
    let (registry, repository) = if explicit_registry {
        (first.to_ascii_lowercase(), remainder.to_owned())
    } else {
        ("docker.io".into(), name.to_owned())
    };
    let registry = if registry == "index.docker.io" {
        "docker.io".into()
    } else {
        registry
    };
    let mut repository = if registry == "docker.io" && !repository.contains('/') {
        format!("library/{repository}")
    } else {
        repository
    };
    let tagged = repository.rsplit('/').next().unwrap_or("").contains(':');
    if digest.is_some() && tagged {
        // The registry (including any port) is already separated from this path.
        repository.truncate(repository.rfind(':').unwrap());
    }
    let mut normalized = format!("{registry}/{repository}");
    if let Some(digest) = digest {
        normalized.push('@');
        normalized.push_str(digest);
    } else if !tagged {
        normalized.push_str(":latest");
    }
    Ok(normalized)
}
fn valid_service_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}
pub(super) fn parse_apply_metadata(
    config: &Value,
    project_name: &str,
) -> Result<ComposeApplyMetadata> {
    let previews = preview_services(config, project_name)?;
    let services = config["services"].as_object().unwrap();
    let mut metadata = BTreeMap::new();
    for service in previews {
        if !valid_service_name(&service.name) {
            return Err(malformed("Compose returned an invalid service name"));
        }
        let config = &services[&service.name];
        let effective_image = normalized_image(
            service
                .image
                .as_deref()
                .unwrap_or(&format!("{project_name}-{}", service.name)),
        )?;
        let mut build_tags = BTreeSet::new();
        let mut build_dependencies = BTreeSet::new();
        if service.build {
            build_tags.insert(effective_image.clone());
            if let Some(tags) = config["build"].get("tags") {
                for tag in tags
                    .as_array()
                    .filter(|tags| tags.len() <= 512)
                    .ok_or_else(|| malformed("Compose build tags are invalid"))?
                {
                    build_tags.insert(normalized_image(
                        tag.as_str()
                            .ok_or_else(|| malformed("Compose build tag is invalid"))?,
                    )?);
                }
            }
            if let Some(contexts) = config["build"].get("additional_contexts") {
                let values: Vec<&str> = if let Some(contexts) = contexts.as_object() {
                    if contexts.len() > 512 {
                        return Err(malformed("Compose build contexts exceed their limit"));
                    }
                    contexts
                        .values()
                        .map(|value| {
                            value
                                .as_str()
                                .ok_or_else(|| malformed("Compose build context is invalid"))
                        })
                        .collect::<Result<_>>()?
                } else if let Some(contexts) = contexts.as_array() {
                    if contexts.len() > 512 {
                        return Err(malformed("Compose build contexts exceed their limit"));
                    }
                    contexts
                        .iter()
                        .map(|value| {
                            value
                                .as_str()
                                .and_then(|value| value.split_once('=').map(|(_, value)| value))
                                .ok_or_else(|| malformed("Compose build context is invalid"))
                        })
                        .collect::<Result<_>>()?
                } else {
                    return Err(malformed("Compose build contexts are invalid"));
                };
                for value in values {
                    if let Some(dependency) = value.strip_prefix("service:") {
                        if !valid_service_name(dependency) {
                            return Err(malformed("Compose build dependency is invalid"));
                        }
                        build_dependencies.insert(dependency.to_owned());
                    }
                }
            }
        }
        let image_mount = config
            .get("volumes")
            .and_then(Value::as_array)
            .is_some_and(|mounts| {
                mounts
                    .iter()
                    .any(|mount| mount.get("type").and_then(Value::as_str) == Some("image"))
            });
        // A provider delegates `up` to an external provisioner rather than
        // recreating a container from the explicitly prepared local image.
        let blocked_reason = if config.get("provider").is_some_and(|value| !value.is_null()) {
            Some("providerUnsupported".to_owned())
        } else {
            image_mount.then(|| "imageMountUnsupported".to_owned())
        };
        let preparations = if blocked_reason.is_some() {
            vec![]
        } else {
            let mut modes = Vec::new();
            if service.image.is_some() {
                modes.push(ComposePreparationMode::Pull);
            }
            if service.build {
                modes.push(ComposePreparationMode::Build);
            }
            modes.push(ComposePreparationMode::None);
            modes
        };
        metadata.insert(
            service.name.clone(),
            ApplyServiceMetadata {
                preview: ComposeApplyService {
                    name: service.name,
                    image: service.image,
                    build: service.build,
                    profiles: service.profiles,
                    preparations,
                    blocked_reason,
                },
                effective_image,
                build_tags,
                build_dependencies,
            },
        );
    }
    Ok(ComposeApplyMetadata { services: metadata })
}

pub(super) fn plan_compose_apply(
    validated: &ValidatedProject,
    selections: &[ComposeServiceSelection],
) -> Result<ComposeApplyPlan> {
    let metadata = validated
        .apply_metadata
        .as_ref()
        .ok_or_else(|| malformed("Missing Compose apply metadata"))?;
    plan_metadata(metadata, selections)
}
fn plan_metadata(
    metadata: &ComposeApplyMetadata,
    selections: &[ComposeServiceSelection],
) -> Result<ComposeApplyPlan> {
    if selections.is_empty() || selections.len() > metadata.services.len() {
        return Err(ApiError::new(
            "InvalidApplySelection",
            "Select at least one service and specify its preparation method",
        ));
    }
    let mut selected = BTreeMap::new();
    for selection in selections {
        let service = metadata.services.get(&selection.service).ok_or_else(|| {
            ApiError::new(
                "InvalidApplySelection",
                "A selected service no longer exists",
            )
        })?;
        if selected
            .insert(&selection.service, selection.preparation)
            .is_some()
        {
            return Err(ApiError::new(
                "InvalidApplySelection",
                "Each service must be selected only once",
            ));
        }
        if service.preview.blocked_reason.as_deref() == Some("providerUnsupported") {
            return Err(ApiError::new(
                "ApplyProviderUnsupported",
                "Provider services delegate to an external provisioner and are not supported for apply",
            ));
        }
        if service.preview.blocked_reason.is_some() {
            return Err(ApiError::new(
                "ApplyImageMountUnsupported",
                "Selected services with image mounts are not supported for apply",
            ));
        }
        if !service
            .preview
            .preparations
            .contains(&selection.preparation)
        {
            return Err(ApiError::new(
                "ApplyPreparationUnavailable",
                "A selected preparation method is unavailable for its service",
            ));
        }
    }
    // Checking every explicitly selected build covers the entire transitive closure,
    // including cycles, without recursive expansion or adding any service implicitly.
    for (name, mode) in &selected {
        if *mode != ComposePreparationMode::Build {
            continue;
        }
        let missing: Vec<_> = metadata.services[*name]
            .build_dependencies
            .iter()
            .filter(|dependency| selected.get(dependency) != Some(&ComposePreparationMode::Build))
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Err(ApiError::new(
                "ApplyBuildDependencyMissing",
                &format!(
                    "Select build preparation for dependencies of {name}: {}",
                    missing.join(", ")
                ),
            ));
        }
    }
    let mut writers: BTreeMap<&str, Vec<(&str, ComposePreparationMode)>> = BTreeMap::new();
    for (name, mode) in &selected {
        let service = &metadata.services[*name];
        match mode {
            ComposePreparationMode::Pull => {
                writers
                    .entry(&service.effective_image)
                    .or_default()
                    .push((name, *mode));
            }
            ComposePreparationMode::Build => {
                for tag in &service.build_tags {
                    writers.entry(tag).or_default().push((name, *mode));
                }
            }
            ComposePreparationMode::None => {}
        }
    }
    for (image, writers) in &writers {
        if writers.len() > 1
            && writers
                .iter()
                .any(|(_, mode)| *mode == ComposePreparationMode::Build)
        {
            return Err(ApiError::new(
                "ApplyImageConflict",
                &format!(
                    "Conflicting preparation writes image {image}: {}",
                    writers
                        .iter()
                        .map(|(name, _)| *name)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
        }
    }
    let relevant_images: BTreeSet<_> = selected
        .keys()
        .map(|name| metadata.services[*name].effective_image.as_str())
        .chain(writers.keys().copied())
        .collect();
    let mut consumers_by_image: BTreeMap<&str, BTreeSet<String>> = BTreeMap::new();
    for (name, service) in &metadata.services {
        consumers_by_image
            .entry(&service.effective_image)
            .or_default()
            .insert(name.clone());
    }
    let mut warnings = Vec::new();
    for image in relevant_images {
        let mut consumers = consumers_by_image.remove(image).unwrap_or_default();
        // Additional build tags may be consumed by a service whose primary image differs.
        if let Some(writers) = writers.get(image) {
            consumers.extend(writers.iter().map(|(name, _)| (*name).to_owned()));
        }
        if consumers.len() > 1 {
            warnings.push(ComposeApplyWarning {
                code: "sharedImage".into(),
                image: image.into(),
                services: consumers.into_iter().collect(),
            });
        }
    }
    let services_for = |mode| {
        selected
            .iter()
            .filter(|(_, preparation)| **preparation == mode)
            .map(|(name, _)| (*name).clone())
            .collect()
    };
    Ok(ComposeApplyPlan {
        selections: selected
            .iter()
            .map(|(service, preparation)| ComposeServiceSelection {
                service: (*service).clone(),
                preparation: *preparation,
            })
            .collect(),
        pull_services: services_for(ComposePreparationMode::Pull),
        build_services: services_for(ComposePreparationMode::Build),
        apply_services: selected.keys().map(|name| (*name).clone()).collect(),
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn metadata(services: Value) -> ComposeApplyMetadata {
        parse_apply_metadata(&json!({"name":"demo", "services":services}), "demo").unwrap()
    }
    fn selection(service: &str, preparation: ComposePreparationMode) -> ComposeServiceSelection {
        ComposeServiceSelection {
            service: service.into(),
            preparation,
        }
    }
    fn code(result: Result<ComposeApplyPlan>) -> String {
        result.err().expect("plan must fail").code
    }

    #[test]
    fn apply_help_requires_exact_flag_tokens() {
        assert!(apply_help_supports_flags(
            "Options:\n  --profile stringArray  Profiles\n  --pull string  Policy\n  --no-build  Skip build\n",
            &["--profile", "--pull", "--no-build"],
        ));
        for (help, required) in [
            ("--profiles stringArray", "--profile"),
            ("--policy-extra string", "--policy"),
            ("--pull-mode string", "--pull"),
            ("--no-build-cache", "--no-build"),
            ("--force-recreate-all", "--force-recreate"),
        ] {
            assert!(!apply_help_supports_flags(help, &[required]));
        }
    }

    #[test]
    fn apply_blocks_selected_provider_without_blocking_other_services() {
        let metadata = metadata(json!({
            "external": {"provider":{"type":"cloud-provider", "options":{"secret":"do-not-return"}}},
            "web": {"image":"web", "depends_on":{"external":{"condition":"service_started"}}},
            "ordinary": {"image":"ordinary", "provider":null}
        }));
        let preview = &metadata.services["external"].preview;
        assert_eq!(
            preview.blocked_reason.as_deref(),
            Some("providerUnsupported")
        );
        assert!(preview.preparations.is_empty());
        let serialized = serde_json::to_string(preview).unwrap();
        assert!(!serialized.contains("cloud-provider"));
        assert!(!serialized.contains("do-not-return"));
        for preparation in [
            ComposePreparationMode::Pull,
            ComposePreparationMode::Build,
            ComposePreparationMode::None,
        ] {
            assert_eq!(
                code(plan_metadata(
                    &metadata,
                    &[selection("external", preparation)]
                )),
                "ApplyProviderUnsupported"
            );
        }
        let plan =
            plan_metadata(&metadata, &[selection("web", ComposePreparationMode::None)]).unwrap();
        assert_eq!(plan.apply_services, vec!["web"]);
        assert!(
            plan_metadata(
                &metadata,
                &[selection("ordinary", ComposePreparationMode::None)]
            )
            .is_ok()
        );
    }

    #[test]
    fn apply_normalizes_default_registry_library_and_tag_only() {
        for reference in [
            "redis",
            "redis:latest",
            "docker.io/redis",
            "index.docker.io/library/redis",
        ] {
            assert_eq!(
                normalized_image(reference).unwrap(),
                "docker.io/library/redis:latest"
            );
        }
        assert_eq!(
            normalized_image("org/worker").unwrap(),
            "docker.io/org/worker:latest"
        );
        assert_eq!(
            normalized_image("LOCALHOST:5000/worker:RC").unwrap(),
            "localhost:5000/worker:RC"
        );
        assert_eq!(
            normalized_image("worker@sha256:abc").unwrap(),
            "docker.io/library/worker@sha256:abc"
        );
        assert_eq!(
            normalized_image("worker:RC@sha256:abc").unwrap(),
            "docker.io/library/worker@sha256:abc"
        );
        assert_ne!(
            normalized_image("worker:RC").unwrap(),
            normalized_image("worker:rc").unwrap()
        );
        assert_ne!(
            normalized_image("worker:latest").unwrap(),
            normalized_image("worker@sha256:abc").unwrap()
        );
    }

    #[test]
    fn apply_normalizes_exact_digest_aliases_without_losing_registry_ports() {
        let digest = format!("sha256:{}", "a".repeat(64));
        let other_digest = format!("sha256:{}", "b".repeat(64));
        for repository in [
            "worker",
            "registry.example:5000/team/worker",
            "[::1]:5000/team/worker",
        ] {
            let tagged = normalized_image(&format!("{repository}:RC@{digest}")).unwrap();
            let untagged = normalized_image(&format!("{repository}@{digest}")).unwrap();
            assert_eq!(tagged, untagged);
            assert_ne!(
                tagged,
                normalized_image(&format!("{repository}@{other_digest}")).unwrap()
            );
            if repository.contains(":5000") {
                assert!(tagged.starts_with(repository));
            }
        }
        assert_eq!(
            normalized_image("registry.example:5000/team/worker:RC").unwrap(),
            "registry.example:5000/team/worker:RC"
        );
    }

    #[test]
    fn apply_warns_for_tagged_and_untagged_consumers_of_the_exact_same_digest() {
        let digest = format!("sha256:{}", "a".repeat(64));
        let metadata = metadata(json!({
            "tagged": {"image":format!("registry.example:5000/team/worker:RC@{digest}")},
            "untagged": {"image":format!("registry.example:5000/team/worker@{digest}")},
            "different": {"image":format!("registry.example:5000/team/worker@sha256:{}", "b".repeat(64))}
        }));
        let plan = plan_metadata(
            &metadata,
            &[selection("tagged", ComposePreparationMode::Pull)],
        )
        .unwrap();
        assert_eq!(plan.apply_services, vec!["tagged"]);
        assert_eq!(
            plan.warnings,
            vec![ComposeApplyWarning {
                code: "sharedImage".into(),
                image: format!("registry.example:5000/team/worker@{digest}"),
                services: vec!["tagged".into(), "untagged".into()],
            }]
        );
    }

    #[test]
    fn apply_preview_retains_profiles_and_only_minimal_capabilities() {
        let metadata = metadata(json!({
            "download": {"image":"redis", "environment":{"PASSWORD":"never-return-this"}},
            "compiler": {"build":{"context":".","args":{"TOKEN":"never-return-this"}}, "profiles":["tools"]},
            "hybrid": {"image":"worker", "build":{"context":"."}},
            "blocked": {"image":"worker", "volumes":[{"type":"image","source":"other-image","target":"/data"}]}
        }));
        assert_eq!(
            metadata.services["download"].preview.preparations,
            vec![ComposePreparationMode::Pull, ComposePreparationMode::None]
        );
        assert_eq!(
            metadata.services["compiler"].preview.preparations,
            vec![ComposePreparationMode::Build, ComposePreparationMode::None]
        );
        assert_eq!(metadata.services["hybrid"].preview.preparations.len(), 3);
        assert_eq!(
            metadata.services["compiler"].preview.profiles,
            vec!["tools"]
        );
        assert_eq!(
            metadata.services["compiler"].effective_image,
            "docker.io/library/demo-compiler:latest"
        );
        assert!(metadata.services["blocked"].preview.preparations.is_empty());
        assert_eq!(
            metadata.services["blocked"]
                .preview
                .blocked_reason
                .as_deref(),
            Some("imageMountUnsupported")
        );
        let previews: Vec<_> = metadata.services.values().map(|s| &s.preview).collect();
        let encoded = serde_json::to_string(&previews).unwrap();
        assert!(!encoded.contains("never-return-this"));
        assert!(!encoded.contains("PASSWORD"));
        assert!(!encoded.contains("context"));
    }

    #[test]
    fn apply_sorts_groups_and_does_not_expand_runtime_dependencies() {
        let metadata = metadata(json!({
            "web":{"image":"web","depends_on":{"db":{"condition":"service_started"}}},
            "db":{"image":"db"},
            "compiler":{"build":{"context":"."},"profiles":["tools"]},
            "local":{"image":"local"}
        }));
        let plan = plan_metadata(
            &metadata,
            &[
                selection("web", ComposePreparationMode::Pull),
                selection("local", ComposePreparationMode::None),
                selection("compiler", ComposePreparationMode::Build),
            ],
        )
        .unwrap();
        assert_eq!(plan.pull_services, vec!["web"]);
        assert_eq!(plan.build_services, vec!["compiler"]);
        assert_eq!(plan.apply_services, vec!["compiler", "local", "web"]);
        assert_eq!(
            plan.selections
                .iter()
                .map(|s| s.service.as_str())
                .collect::<Vec<_>>(),
            vec!["compiler", "local", "web"]
        );
        assert!(!plan.apply_services.contains(&"db".into()));
    }

    #[test]
    fn apply_requires_nonempty_unique_existing_explicit_modes() {
        let metadata = metadata(json!({"web":{"image":"web"},"worker":{"image":"worker"}}));
        assert_eq!(code(plan_metadata(&metadata, &[])), "InvalidApplySelection");
        assert_eq!(
            code(plan_metadata(
                &metadata,
                &[selection("missing", ComposePreparationMode::None)]
            )),
            "InvalidApplySelection"
        );
        assert_eq!(
            code(plan_metadata(
                &metadata,
                &[
                    selection("web", ComposePreparationMode::None),
                    selection("web", ComposePreparationMode::Pull)
                ]
            )),
            "InvalidApplySelection"
        );
        assert!(
            serde_json::from_value::<ComposeServiceSelection>(json!({"service":"web"})).is_err()
        );
        assert!(
            serde_json::from_value::<ComposeServiceSelection>(
                json!({"service":"web","preparation":"auto"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<ComposeServiceSelection>(
                json!({"service":"web","preparation":"none","command":"restart"})
            )
            .is_err()
        );
    }

    #[test]
    fn apply_rejects_unavailable_preparations_and_selected_image_mounts() {
        let metadata = metadata(json!({
            "image":{"image":"web"},
            "source":{"build":{"context":"."}},
            "blocked":{"image":"web","volumes":[{"type":"image","source":"busybox","target":"/data"}]}
        }));
        assert_eq!(
            code(plan_metadata(
                &metadata,
                &[selection("image", ComposePreparationMode::Build)]
            )),
            "ApplyPreparationUnavailable"
        );
        assert_eq!(
            code(plan_metadata(
                &metadata,
                &[selection("source", ComposePreparationMode::Pull)]
            )),
            "ApplyPreparationUnavailable"
        );
        for mode in [ComposePreparationMode::Pull, ComposePreparationMode::None] {
            assert_eq!(
                code(plan_metadata(&metadata, &[selection("blocked", mode)])),
                "ApplyImageMountUnsupported"
            );
        }
        assert!(
            plan_metadata(
                &metadata,
                &[selection("image", ComposePreparationMode::None)]
            )
            .is_ok()
        );
    }

    #[test]
    fn apply_requires_all_transitive_service_build_dependencies_as_build() {
        let metadata = metadata(json!({
            "app":{"build":{"context":".","additional_contexts":{"base":"service:base"}}},
            "base":{"image":"base","build":{"context":".","additional_contexts":["foundation=service:foundation"]}},
            "foundation":{"build":{"context":"."}}
        }));
        for base_mode in [ComposePreparationMode::Pull, ComposePreparationMode::None] {
            assert_eq!(
                code(plan_metadata(
                    &metadata,
                    &[
                        selection("app", ComposePreparationMode::Build),
                        selection("base", base_mode)
                    ]
                )),
                "ApplyBuildDependencyMissing"
            );
        }
        assert_eq!(
            code(plan_metadata(
                &metadata,
                &[
                    selection("app", ComposePreparationMode::Build),
                    selection("base", ComposePreparationMode::Build)
                ]
            )),
            "ApplyBuildDependencyMissing"
        );
        let plan = plan_metadata(
            &metadata,
            &[
                selection("app", ComposePreparationMode::Build),
                selection("base", ComposePreparationMode::Build),
                selection("foundation", ComposePreparationMode::Build),
            ],
        )
        .unwrap();
        assert_eq!(plan.build_services, vec!["app", "base", "foundation"]);
        // Dependencies only apply to a selected build, not an image already prepared locally.
        assert!(
            plan_metadata(&metadata, &[selection("app", ComposePreparationMode::None)]).is_ok()
        );
    }

    #[test]
    fn apply_build_dependency_cycles_terminate_without_implicit_selection() {
        let metadata = metadata(json!({
            "a":{"build":{"additional_contexts":{"b":"service:b"}}},
            "b":{"build":{"additional_contexts":{"a":"service:a"}}}
        }));
        assert_eq!(
            code(plan_metadata(
                &metadata,
                &[selection("a", ComposePreparationMode::Build)]
            )),
            "ApplyBuildDependencyMissing"
        );
        assert!(
            plan_metadata(
                &metadata,
                &[
                    selection("a", ComposePreparationMode::Build),
                    selection("b", ComposePreparationMode::Build)
                ]
            )
            .is_ok()
        );
    }

    #[test]
    fn apply_blocks_pull_build_and_distinct_build_writers_after_normalization() {
        let metadata = metadata(json!({
            "download":{"image":"redis"},
            "build":{"image":"docker.io/library/redis:latest","build":{"context":"."}},
            "second":{"image":"index.docker.io/redis","build":{"context":"."}}
        }));
        assert_eq!(
            code(plan_metadata(
                &metadata,
                &[
                    selection("download", ComposePreparationMode::Pull),
                    selection("build", ComposePreparationMode::Build)
                ]
            )),
            "ApplyImageConflict"
        );
        assert_eq!(
            code(plan_metadata(
                &metadata,
                &[
                    selection("second", ComposePreparationMode::Build),
                    selection("build", ComposePreparationMode::Build)
                ]
            )),
            "ApplyImageConflict"
        );
        assert!(
            plan_metadata(
                &metadata,
                &[
                    selection("download", ComposePreparationMode::Pull),
                    selection("build", ComposePreparationMode::Pull)
                ]
            )
            .is_ok()
        );
        assert!(
            plan_metadata(
                &metadata,
                &[
                    selection("second", ComposePreparationMode::None),
                    selection("build", ComposePreparationMode::Build)
                ]
            )
            .is_ok()
        );
    }

    #[test]
    fn apply_includes_build_tags_and_default_image_in_conflict_writes() {
        let metadata = metadata(json!({
            "compiler":{"build":{"tags":["extra","docker.io/extra:latest"]}},
            "pull-extra":{"image":"index.docker.io/library/extra:latest"},
            "pull-default":{"image":"demo-compiler"},
            "other-compiler":{"build":{"tags":["extra"]}}
        }));
        for other in ["pull-extra", "pull-default"] {
            assert_eq!(
                code(plan_metadata(
                    &metadata,
                    &[
                        selection("compiler", ComposePreparationMode::Build),
                        selection(other, ComposePreparationMode::Pull)
                    ]
                )),
                "ApplyImageConflict"
            );
        }
        assert_eq!(
            code(plan_metadata(
                &metadata,
                &[
                    selection("compiler", ComposePreparationMode::Build),
                    selection("other-compiler", ComposePreparationMode::Build)
                ]
            )),
            "ApplyImageConflict"
        );
        // Alias tags written by the same service count as one writer.
        assert!(
            plan_metadata(
                &metadata,
                &[selection("compiler", ComposePreparationMode::Build)]
            )
            .is_ok()
        );
    }

    #[test]
    fn apply_warns_about_unselected_and_none_consumers_without_selecting_them() {
        let metadata = metadata(json!({
            "compiler":{"image":"other","build":{"tags":["shared"]}},
            "consumer":{"image":"shared:latest"},
            "unselected":{"image":"docker.io/shared"},
            "unrelated":{"image":"separate"}
        }));
        let plan = plan_metadata(
            &metadata,
            &[
                selection("compiler", ComposePreparationMode::Build),
                selection("consumer", ComposePreparationMode::None),
            ],
        )
        .unwrap();
        assert_eq!(plan.apply_services, vec!["compiler", "consumer"]);
        assert_eq!(
            plan.warnings,
            vec![ComposeApplyWarning {
                code: "sharedImage".into(),
                image: "docker.io/library/shared:latest".into(),
                services: vec!["compiler".into(), "consumer".into(), "unselected".into()]
            }]
        );
    }

    #[test]
    fn apply_rejects_malformed_bounded_metadata_without_returning_config() {
        for services in [
            json!({"bad service":{"image":"web"}}),
            json!({"web":{"image":""}}),
            json!({"web":{"image":"hello world"}}),
            json!({"web":{"build":{"tags":[123]}}}),
            json!({"web":{"build":{"additional_contexts":{"base":42}}}}),
            json!({"web":{"build":{"additional_contexts":{"base":"service:bad/name"}}}}),
        ] {
            let result = parse_apply_metadata(&json!({"name":"demo","services":services}), "demo");
            assert_eq!(
                result.err().expect("invalid metadata must fail").code,
                "MalformedOutput"
            );
        }
    }

    #[test]
    fn apply_accepts_compose_service_names_that_resemble_options() {
        let metadata = metadata(json!({
            "--all":{"image":"web"},
            "_worker":{"image":"worker"},
            ".tool":{"image":"tool"}
        }));
        let plan = plan_metadata(
            &metadata,
            &[
                selection("--all", ComposePreparationMode::Pull),
                selection("_worker", ComposePreparationMode::None),
                selection(".tool", ComposePreparationMode::None),
            ],
        )
        .unwrap();
        assert_eq!(plan.apply_services, vec!["--all", ".tool", "_worker"]);
    }
}
