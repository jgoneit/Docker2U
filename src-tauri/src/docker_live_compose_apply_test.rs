//! Opt-in mutation evidence through the production Core Compose API.
use super::*;
use std::{collections::BTreeMap, fs, thread, time::Instant};

const OWNER: &str = "io.github.jgoneit.docker2u.compose-apply-smoke";

struct OwnedProject {
    core: Core,
    session: Session,
    root: PathBuf,
    name: String,
    nonce: String,
    cleaned: bool,
}

impl OwnedProject {
    fn command(&self, arguments: &[&str]) -> Vec<u8> {
        self.core.verify(&self.session.target).unwrap();
        self.core
            .docker(&self.session.target, arguments, 30)
            .unwrap()
    }

    fn inspect(&self, kind: &str, id: &str) -> Value {
        serde_json::from_slice::<Vec<Value>>(&self.command(&[kind, "inspect", id]))
            .unwrap()
            .remove(0)
    }

    fn owned_ids(&self, kind: &str) -> Vec<String> {
        let filter = format!("label={OWNER}={}", self.nonce);
        let arguments = if kind == "container" {
            vec![
                kind,
                "ls",
                "--all",
                "--quiet",
                "--no-trunc",
                "--filter",
                &filter,
            ]
        } else if kind == "image" {
            vec![kind, "ls", "--quiet", "--no-trunc", "--filter", &filter]
        } else {
            vec![kind, "ls", "--quiet", "--filter", &filter]
        };
        let mut ids: Vec<String> = String::from_utf8(self.command(&arguments))
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    fn containers(&self) -> BTreeMap<String, Value> {
        self.owned_ids("container")
            .into_iter()
            .map(|id| {
                let value = self.inspect("container", &id);
                assert_eq!(value["Config"]["Labels"][OWNER], self.nonce);
                assert_eq!(
                    value["Config"]["Labels"]["com.docker.compose.project"],
                    self.name
                );
                let service = value["Config"]["Labels"]["com.docker.compose.service"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                (service, value)
            })
            .collect()
    }

    fn write_config(&self, base: &str, revision: &str) {
        let mut services = serde_json::Map::new();
        for service in ["puller", "builder", "config", "untouched"] {
            let mut config = serde_json::json!({
                "image": base,
                "command": ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
                "network_mode": "none",
                "stop_grace_period": "1s",
                "healthcheck": {
                    "test":["CMD", "test", "-f", "/shared/marker"],
                    "interval":"1s", "timeout":"1s", "retries":5
                },
                "labels": {OWNER: self.nonce},
                "environment": {"APPLY_REVISION": revision},
                "volumes": [
                    {"type":"bind", "source":self.root.join("shared"), "target":"/shared", "read_only":true},
                    {"type":"volume", "source":"data", "target":"/data"}
                ]
            });
            if service == "builder" {
                config["image"] = format!("{}-built:smoke", self.name).into();
                config["build"] = serde_json::json!({"context":".", "dockerfile":"Dockerfile"});
            }
            if service == "puller" {
                config["depends_on"] = serde_json::json!(["untouched"]);
            }
            services.insert(service.into(), config);
        }
        fs::write(
            self.root.join("compose.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "services":services,
                "volumes":{"data":{"labels":{OWNER:self.nonce}}}
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn write_dockerfile(&self, base: &str, revision: &str) {
        fs::write(
            self.root.join("Dockerfile"),
            format!(
                "FROM {base}\nLABEL {OWNER}=\"{}\"\nLABEL docker2u.smoke.revision=\"{revision}\"\n",
                self.nonce
            ),
        )
        .unwrap();
    }

    fn apply(&self, project: &ComposeProject, modes: &[(&str, &str)]) {
        let selections = modes
            .iter()
            .map(|(service, preparation)| {
                serde_json::from_value(
                    serde_json::json!({"service":service,"preparation":preparation}),
                )
                .unwrap()
            })
            .collect();
        let preview = self
            .core
            .prepare_compose_operation(
                &self.session.id,
                &project.id,
                project.revision,
                ComposeAction::Apply,
                Some(selections),
            )
            .unwrap();
        let started = self
            .core
            .start_compose_operation(
                &self.session.id,
                &preview.prepare_id,
                &uuid::Uuid::new_v4().to_string(),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            let read = self
                .core
                .read_compose_operation(&self.session.id, &started.id, 0)
                .unwrap();
            if read.operation.phase == "finished" {
                assert_eq!(
                    read.operation.outcome.as_deref(),
                    Some("succeeded"),
                    "{read:?}"
                );
                assert_eq!(read.operation.reconciliation, "succeeded", "{read:?}");
                let stages = serde_json::to_value(&read.operation.stages).unwrap();
                for stage in stages.as_array().unwrap() {
                    assert_eq!(
                        stage["status"],
                        if stage["services"].as_array().unwrap().is_empty() {
                            "skipped"
                        } else {
                            "succeeded"
                        },
                        "{read:?}"
                    );
                }
                eprintln!(
                    "real Compose apply modes={modes:?}, stages={stages}, reconciled={:?}",
                    read.operation.observed_containers
                );
                break;
            }
            if Instant::now() >= deadline {
                let _ = self
                    .core
                    .cancel_compose_operation(&self.session.id, &started.id);
                panic!("Timed out waiting for real Compose apply: {read:?}");
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    fn assert_mount_data(&self, rows: &BTreeMap<String, Value>, volume: &str) {
        for value in rows.values() {
            let id = value["Id"].as_str().unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            let current = loop {
                let current = self.inspect("container", id);
                assert_eq!(current["State"]["Status"], "running");
                if current["State"]["Health"]["Status"] == "healthy" {
                    break current;
                }
                assert!(
                    Instant::now() < deadline,
                    "Owned fixture did not become healthy: {current}"
                );
                thread::sleep(Duration::from_millis(100));
            };
            let mounts = current["Mounts"].as_array().unwrap();
            assert!(mounts.iter().any(|mount| mount["Type"] == "volume"
                && mount["Name"] == volume
                && mount["Destination"] == "/data"));
            assert!(
                mounts.iter().any(|mount| mount["Type"] == "bind"
                    && mount["Source"].as_str().is_some_and(|source| {
                        // Docker Desktop may return its VM /host_mnt alias for
                        // the same macOS source; retain exact path comparison.
                        source.strip_prefix("/host_mnt").unwrap_or(source)
                            == self.root.join("shared").to_string_lossy().as_ref()
                    })
                    && mount["Destination"] == "/shared"
                    && mount["RW"] == false),
                "Expected bind root {}, actual mounts: {mounts:?}",
                self.root.display()
            );
            let output = self.command(&["exec", id, "cat", "/shared/marker", "/data/marker"]);
            assert_eq!(
                String::from_utf8(output).unwrap(),
                format!("bind:{}\nvolume:{}\n", self.nonce, self.nonce)
            );
        }
    }

    fn cleanup(&mut self) -> Result<()> {
        if self.cleaned {
            return Ok(());
        }
        self.core.cancel_all_compose_and_wait();
        self.core.verify(&self.session.target)?;
        for kind in ["container", "volume", "image"] {
            for id in self.owned_ids(kind) {
                let proof = self.inspect(kind, &id);
                let labels = if kind == "volume" {
                    &proof["Labels"]
                } else {
                    &proof["Config"]["Labels"]
                };
                if labels[OWNER] != self.nonce {
                    return Err(ApiError::new(
                        "InvalidSelection",
                        "Owned fixture cleanup label mismatch",
                    ));
                }
                if kind != "image" && labels["com.docker.compose.project"] != self.name {
                    return Err(ApiError::new(
                        "InvalidSelection",
                        "Owned fixture cleanup project mismatch",
                    ));
                }
                let arguments = if kind == "container" {
                    vec![kind, "rm", "--force", &id]
                } else {
                    vec![kind, "rm", &id]
                };
                self.core.verify(&self.session.target)?;
                self.core.docker(&self.session.target, &arguments, 30)?;
            }
            assert!(self.owned_ids(kind).is_empty(), "Owned {kind} remained");
        }
        self.cleaned = true;
        fs::remove_dir_all(&self.root).unwrap();
        eprintln!("real Compose exact owned cleanup completed: {}", self.name);
        Ok(())
    }
}

impl Drop for OwnedProject {
    fn drop(&mut self) {
        // Do not panic a second time if the test failed while the Engine was unavailable.
        let cleanup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.cleanup()));
        if !matches!(cleanup, Ok(Ok(()))) {
            eprintln!(
                "Owned Compose fixture cleanup needs attention: {} at {}",
                self.name,
                self.root.display()
            );
        }
    }
}

fn assert_recreated(
    before: &BTreeMap<String, Value>,
    after: &BTreeMap<String, Value>,
    selected: &[&str],
) {
    assert_eq!(before.len(), after.len());
    for (name, row) in before {
        if selected.contains(&name.as_str()) {
            assert_ne!(
                row["Id"], after[name]["Id"],
                "Selected service {name} was not recreated"
            );
        } else {
            assert_eq!(
                row["Id"], after[name]["Id"],
                "Unselected service {name} changed"
            );
        }
    }
}

/// Creates only UUID-labeled fixtures; never invokes Compose down, prune, or rm -v.
#[test]
#[ignore = "Requires a running local Docker Engine and DOCKER2U_REAL_COMPOSE_APPLY=1"]
fn real_compose_apply_preserves_unselected_services_and_shared_data() {
    assert_eq!(
        std::env::var("DOCKER2U_REAL_COMPOSE_APPLY").as_deref(),
        Ok("1")
    );
    let core = Core::default();
    let environment = core.get_environment().unwrap();
    assert_eq!(environment.status, "ready", "{environment:?}");
    assert!(environment.mutation_allowed);
    let session = core
        .active(environment.session_id.as_deref().unwrap())
        .unwrap();
    core.list_containers(&session.id).unwrap();
    eprintln!(
        "real Compose target context={:?}, endpoint={}, engine={}",
        environment.context_name, session.target.endpoint, session.target.fingerprint.id
    );
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let root = std::env::temp_dir().join(format!("docker2u-compose-apply-{nonce}"));
    fs::create_dir_all(root.join("shared")).unwrap();
    let root = fs::canonicalize(root).unwrap();
    core.set_compose_storage_path(root.join("registry.json"))
        .unwrap();
    let mut owned = OwnedProject {
        core,
        session,
        root,
        name: format!("docker2u-apply-{}", &nonce[..12]),
        nonce,
        cleaned: false,
    };
    let baseline = owned.command(&[
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--format",
        "{{.ID}} {{.Image}} {{.Names}}",
    ]);
    // An immutable, public base avoids overwriting any pre-existing mutable image tag.
    let base = "busybox@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0";
    fs::write(
        owned.root.join("shared/marker"),
        format!("bind:{}\n", owned.nonce),
    )
    .unwrap();
    owned.write_config(base, "one");
    owned.write_dockerfile(base, "one");
    let registration = owned
        .core
        .preview_compose_project(
            &owned.session.id,
            ComposeProjectInput {
                id: None,
                expected_revision: None,
                name: owned.name.clone(),
                compose_file: owned
                    .root
                    .join("compose.json")
                    .to_string_lossy()
                    .into_owned(),
                working_directory: owned.root.to_string_lossy().into_owned(),
                env_file: Some(String::new()),
            },
        )
        .unwrap();
    let project = owned
        .core
        .save_compose_project(&registration.preview_id)
        .unwrap();
    let apply_preview = owned
        .core
        .preview_compose_apply(&owned.session.id, &project.id, project.revision)
        .unwrap();
    assert_eq!(apply_preview.services.len(), 4);
    let mixed = [("puller", "pull"), ("builder", "build"), ("config", "none")];
    owned.apply(
        &project,
        &[
            ("puller", "pull"),
            ("builder", "build"),
            ("config", "none"),
            ("untouched", "none"),
        ],
    );
    let initial = owned.containers();
    assert_eq!(initial.len(), 4);
    let volume = owned.owned_ids("volume");
    assert_eq!(volume.len(), 1);
    owned.command(&[
        "exec",
        initial["config"]["Id"].as_str().unwrap(),
        "sh",
        "-c",
        "printf 'volume:%s\\n' \"$1\" > /data/marker",
        "sh",
        &owned.nonce,
    ]);
    owned.assert_mount_data(&initial, &volume[0]);

    owned.apply(&project, &[("puller", "pull")]);
    let pulled = owned.containers();
    assert_recreated(&initial, &pulled, &["puller"]);

    owned.write_dockerfile(base, "two");
    owned.apply(&project, &[("builder", "build")]);
    let built = owned.containers();
    assert_recreated(&pulled, &built, &["builder"]);
    assert_ne!(pulled["builder"]["Image"], built["builder"]["Image"]);
    assert_eq!(
        built["builder"]["Config"]["Labels"]["docker2u.smoke.revision"],
        "two"
    );

    owned.write_config(base, "two");
    owned.apply(&project, &[("config", "none")]);
    let configured = owned.containers();
    assert_recreated(&built, &configured, &["config"]);
    assert!(
        configured["config"]["Config"]["Env"]
            .as_array()
            .unwrap()
            .contains(&Value::String("APPLY_REVISION=two".into()))
    );
    assert!(
        configured["untouched"]["Config"]["Env"]
            .as_array()
            .unwrap()
            .contains(&Value::String("APPLY_REVISION=one".into()))
    );

    owned.write_dockerfile(base, "three");
    owned.apply(&project, &mixed);
    let applied = owned.containers();
    assert_recreated(&configured, &applied, &["puller", "builder", "config"]);
    assert_eq!(applied["untouched"]["Id"], initial["untouched"]["Id"]);
    assert_eq!(
        applied["builder"]["Config"]["Labels"]["docker2u.smoke.revision"],
        "three"
    );
    owned.assert_mount_data(&applied, &volume[0]);
    let inventory = owned.core.list_containers(&owned.session.id).unwrap();
    for value in applied.values() {
        let row = inventory
            .containers
            .iter()
            .find(|row| row.full_id == value["Id"].as_str().unwrap())
            .unwrap();
        assert_eq!(row.state, "running");
        assert_eq!(row.health.as_deref(), Some("healthy"));
    }
    eprintln!(
        "real Compose verified 5 Core operations: pull, Dockerfile rebuild, config-only none, mixed stages, unchanged unselected ID, shared bind/volume data"
    );
    owned.cleanup().unwrap();
    assert_eq!(
        owned.command(&[
            "container",
            "ls",
            "--all",
            "--no-trunc",
            "--format",
            "{{.ID}} {{.Image}} {{.Names}}"
        ]),
        baseline,
        "Existing containers changed during isolated smoke"
    );
}
