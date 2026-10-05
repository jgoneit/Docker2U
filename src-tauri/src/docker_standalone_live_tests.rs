//! Opt-in validation against explicitly owned fixtures on the pinned local Engine.
use super::*;
use std::thread;

const OWNER_LABEL: &str = "io.github.jgoneit.docker2u.validation";
const CHILD_LABEL: &str = "io.github.jgoneit.docker2u.standalone-test";

struct OwnedRun {
    core: Core,
    target: Target,
    owner: String,
    nonce: String,
    created: Vec<String>,
    restore_health: Option<String>,
}
impl OwnedRun {
    fn inspect(&self, id: &str, child: bool) -> Value {
        assert!(valid_id(id));
        self.core.verify(&self.target).unwrap();
        let rows: Vec<Value> = serde_json::from_slice(
            &self
                .core
                .docker(&self.target, &["container", "inspect", id], 15)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["Id"].as_str(), Some(id));
        assert_eq!(
            rows[0]["Config"]["Labels"][OWNER_LABEL].as_str(),
            Some(self.owner.as_str())
        );
        if child {
            assert_eq!(
                rows[0]["Config"]["Labels"][CHILD_LABEL].as_str(),
                Some(self.nonce.as_str())
            );
        }
        rows.into_iter().next().unwrap()
    }
    fn mutate(&self, id: &str, child: bool, arguments: &[&str]) {
        self.inspect(id, child);
        assert!(
            arguments.contains(&id),
            "mutation must target the checked exact ID"
        );
        self.core.docker(&self.target, arguments, 20).unwrap();
    }
    fn create(&mut self, name: &str, image: &str, marker: &str) -> String {
        self.core.verify(&self.target).unwrap();
        let owner_label = format!("{OWNER_LABEL}={}", self.owner);
        let child_label = format!("{CHILD_LABEL}={}", self.nonce);
        let script = format!("while true; do echo {marker}; sleep 1; done");
        let output = self
            .core
            .docker(
                &self.target,
                &[
                    "container",
                    "create",
                    "--name",
                    name,
                    "--network",
                    "none",
                    "--read-only",
                    "--tmpfs",
                    "/tmp",
                    "--cap-drop",
                    "ALL",
                    "--memory",
                    "64m",
                    "--cpus",
                    "0.2",
                    "--label",
                    &owner_label,
                    "--label",
                    &child_label,
                    "--health-cmd",
                    "test ! -f /tmp/unhealthy",
                    "--health-interval",
                    "1s",
                    "--health-timeout",
                    "1s",
                    "--health-retries",
                    "1",
                    image,
                    "/bin/sh",
                    "-c",
                    &script,
                ],
                20,
            )
            .unwrap();
        let id = String::from_utf8(output).unwrap().trim().to_owned();
        assert!(valid_id(&id));
        self.created.push(id.clone());
        self.mutate(&id, true, &["container", "start", &id]);
        id
    }
}
impl Drop for OwnedRun {
    fn drop(&mut self) {
        // Cleanup stays pinned and verifies ownership again. Never resolve names.
        if self.core.verify(&self.target).is_ok() {
            if let Some(id) = &self.restore_health {
                if let Ok(bytes) = self
                    .core
                    .docker(&self.target, &["container", "inspect", id], 15)
                {
                    if let Ok(rows) = serde_json::from_slice::<Vec<Value>>(&bytes) {
                        if rows.first().is_some_and(|row| {
                            row["Id"].as_str() == Some(id.as_str())
                                && row["Config"]["Labels"][OWNER_LABEL].as_str()
                                    == Some(self.owner.as_str())
                        }) {
                            let _ = self.core.docker(
                                &self.target,
                                &["container", "exec", id, "rm", "-f", "/tmp/unhealthy"],
                                15,
                            );
                        }
                    }
                }
            }
            for id in &self.created {
                let Ok(bytes) = self
                    .core
                    .docker(&self.target, &["container", "inspect", id], 15)
                else {
                    continue;
                };
                let Ok(rows) = serde_json::from_slice::<Vec<Value>>(&bytes) else {
                    continue;
                };
                if rows.first().is_some_and(|row| {
                    row["Id"].as_str() == Some(id.as_str())
                        && row["Config"]["Labels"][OWNER_LABEL].as_str()
                            == Some(self.owner.as_str())
                        && row["Config"]["Labels"][CHILD_LABEL].as_str()
                            == Some(self.nonce.as_str())
                }) {
                    let _ = self
                        .core
                        .docker(&self.target, &["container", "rm", "--force", id], 20);
                }
            }
        }
        self.core.shutdown();
    }
}

fn wait_for<T>(mut read: impl FnMut() -> Option<T>, label: &str) -> T {
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        if let Some(value) = read() {
            return value;
        }
        assert!(Instant::now() < deadline, "live fixture timed out: {label}");
        thread::sleep(Duration::from_millis(100));
    }
}
fn standalone_query_for(id: &str) -> StandaloneLogQuery {
    serde_json::from_value(serde_json::json!({"sourceIds":[id]})).unwrap()
}
fn selected_configuration(core: &Core) -> (Option<LogScope>, Option<HashSet<String>>) {
    let manager = core.project_logs.lock().unwrap();
    (manager.scope.clone(), manager.explicit.clone())
}
fn live_incident(
    core: &Core,
    session: &str,
    id: &str,
    after: u64,
) -> observation::ObservationEvent {
    wait_for(
        || {
            let read = core.read_observation(session, after).unwrap();
            read.events.into_iter().find(|event| {
                event.full_id.as_deref() == Some(id) && event.kind == "health_status: unhealthy"
            })
        },
        "health event",
    )
}
fn assert_resources(core: &Core, session: &str, id: &str, event_time: &str) {
    let at = nanos(event_time).unwrap();
    wait_for(
        || {
            core.read_observation(session, 0)
                .unwrap()
                .resources
                .into_iter()
                .find(|point| {
                    point.full_id == id
                        && point.available
                        && point.cpu_percent.is_some()
                        && point.memory_usage_bytes.is_some()
                        && nanos(&point.sampled_at)
                            .is_some_and(|time| time.abs_diff(at) <= 120_000_000_000)
                })
        },
        "available resource sample within the incident interval",
    );
}

#[test]
#[ignore = "Requires DOCKER2U_REAL_STANDALONE_TEST=1, explicit manifest/run, and owned running Compose fixtures; creates and removes its own labelled standalone container"]
fn real_standalone_and_compose_incidents_keep_retained_ids_across_recreation() {
    assert_eq!(
        std::env::var("DOCKER2U_REAL_STANDALONE_TEST").as_deref(),
        Ok("1")
    );
    let path = std::env::var("DOCKER2U_REAL_STANDALONE_MANIFEST")
        .expect("explicit owned fixture manifest");
    let manifest: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let owner = std::env::var("DOCKER2U_REAL_STANDALONE_RUN").expect("explicit run owner");
    assert!(owner.starts_with("d2u-terminal-") && owner.len() <= 80);
    assert_eq!(manifest["run"].as_str(), Some(owner.as_str()));
    let compose_id = manifest["composeIds"][0].as_str().unwrap().to_owned();
    let original_standalone = manifest["standalone"][0].as_str().unwrap();
    let image = manifest["image"].as_str().unwrap();
    assert!(image.strip_prefix("sha256:").is_some_and(valid_id));
    let core = Core::default();
    let environment = core.get_environment().unwrap();
    assert_eq!(environment.status, "ready", "{environment:?}");
    let session = core
        .active(environment.session_id.as_deref().unwrap())
        .unwrap();
    assert_eq!(
        manifest["endpoint"].as_str(),
        Some(session.target.endpoint.as_str())
    );
    let mut owned = OwnedRun {
        core: core.clone(),
        target: session.target.clone(),
        owner,
        nonce: uuid::Uuid::new_v4().simple().to_string(),
        created: vec![],
        restore_health: None,
    };
    owned.inspect(original_standalone, false);
    let composed = owned.inspect(&compose_id, false);
    assert_eq!(composed["State"]["Running"], true);
    assert!(
        composed["Config"]["Healthcheck"]["Test"]
            .as_array()
            .is_some()
    );
    let project = composed["Config"]["Labels"]["com.docker.compose.project"]
        .as_str()
        .unwrap()
        .to_owned();
    let name = format!("{}-incident-{}", owned.owner, &owned.nonce[..8]);
    let old_id = owned.create(&name, image, "D2U_STANDALONE_OLD");
    core.configure_observation(&session.id, ObservationScope::None)
        .unwrap();
    let old = wait_for(
        || {
            core.list_containers(&session.id)
                .unwrap()
                .containers
                .into_iter()
                .find(|container| container.full_id == old_id)
        },
        "new standalone inventory",
    );
    core.configure_standalone_logs(&session.id, Some(vec![old.handle]))
        .unwrap();
    wait_for(
        || {
            let logs = core
                .query_standalone_logs(&session.id, &standalone_query_for(&old_id))
                .unwrap();
            logs.rows
                .iter()
                .any(|row| row.text.contains("D2U_STANDALONE_OLD"))
                .then_some(())
        },
        "standalone retained logs",
    );
    wait_for(
        || {
            (core.read_observation(&session.id, 0).unwrap().event_status == "following")
                .then_some(())
        },
        "event stream following",
    );
    let before = core.read_observation(&session.id, 0).unwrap().sequence;
    owned.mutate(
        &old_id,
        true,
        &["container", "exec", &old_id, "touch", "/tmp/unhealthy"],
    );
    let incident = live_incident(&core, &session.id, &old_id, before);
    assert!(incident.compose_project.is_none());
    assert_resources(&core, &session.id, &old_id, &incident.occurred_at);
    let at = chrono::DateTime::parse_from_rfc3339(&incident.occurred_at).unwrap();
    let mut query = standalone_query_for(&old_id);
    query.time_from = Some((at - chrono::Duration::minutes(2)).to_rfc3339());
    query.time_to = Some((at + chrono::Duration::minutes(2)).to_rfc3339());
    query.anchor_time = Some(incident.occurred_at.clone());
    let configured = selected_configuration(&core);
    let retained = core.query_standalone_logs(&session.id, &query).unwrap();
    assert!(!retained.rows.is_empty());
    assert!(retained.rows.iter().all(|row| row.full_id == old_id));
    assert_eq!(selected_configuration(&core), configured);
    owned.mutate(&old_id, true, &["container", "rm", "--force", &old_id]);
    let new_id = owned.create(&name, image, "D2U_STANDALONE_NEW");
    assert_ne!(new_id, old_id);
    let replacement = wait_for(
        || {
            core.list_containers(&session.id)
                .unwrap()
                .containers
                .into_iter()
                .find(|container| container.full_id == new_id)
        },
        "same-name replacement inventory",
    );
    let before_apply = core
        .query_standalone_logs(&session.id, &standalone_query_for(&old_id))
        .unwrap();
    assert!(
        before_apply
            .sources
            .iter()
            .any(|source| source.full_id == old_id && source.status == "removed")
    );
    assert!(
        before_apply
            .sources
            .iter()
            .any(|source| source.full_id == new_id && !source.selected)
    );
    assert_eq!(selected_configuration(&core), configured);
    core.configure_standalone_logs(&session.id, Some(vec![replacement.handle]))
        .unwrap();
    wait_for(
        || {
            core.query_standalone_logs(&session.id, &standalone_query_for(&new_id))
                .unwrap()
                .rows
                .iter()
                .any(|row| row.text.contains("D2U_STANDALONE_NEW"))
                .then_some(())
        },
        "replacement log retention",
    );
    let old_retained = core.query_standalone_logs(&session.id, &query).unwrap();
    assert!(!old_retained.rows.is_empty());
    assert!(
        old_retained
            .rows
            .iter()
            .all(|row| row.full_id == old_id && !row.text.contains("D2U_STANDALONE_NEW"))
    );

    core.configure_observation(
        &session.id,
        ObservationScope::Project {
            name: project.clone(),
        },
    )
    .unwrap();
    let composed = core
        .list_containers(&session.id)
        .unwrap()
        .containers
        .into_iter()
        .find(|container| container.full_id == compose_id)
        .unwrap();
    core.configure_project_logs(&session.id, &project, Some(vec![composed.handle]))
        .unwrap();
    wait_for(
        || {
            core.query_project_logs(&session.id, &latest_query(project.clone()))
                .unwrap()
                .rows
                .iter()
                .any(|row| row.full_id == compose_id)
                .then_some(())
        },
        "Compose retained logs",
    );
    let before = core.read_observation(&session.id, 0).unwrap().sequence;
    owned.restore_health = Some(compose_id.clone());
    owned.mutate(
        &compose_id,
        false,
        &["container", "exec", &compose_id, "touch", "/tmp/unhealthy"],
    );
    let compose_event = live_incident(&core, &session.id, &compose_id, before);
    assert_eq!(
        compose_event.compose_project.as_deref(),
        Some(project.as_str())
    );
    assert_resources(&core, &session.id, &compose_id, &compose_event.occurred_at);
    owned.mutate(
        &compose_id,
        false,
        &[
            "container",
            "exec",
            &compose_id,
            "rm",
            "-f",
            "/tmp/unhealthy",
        ],
    );
    owned.restore_health = None;
    let at = chrono::DateTime::parse_from_rfc3339(&compose_event.occurred_at).unwrap();
    let mut project_query = latest_query(project.clone());
    project_query.source_ids = vec![compose_id.clone()];
    project_query.time_from = Some((at - chrono::Duration::minutes(2)).to_rfc3339());
    project_query.time_to = Some((at + chrono::Duration::minutes(2)).to_rfc3339());
    project_query.anchor_time = Some(compose_event.occurred_at.clone());
    let configured = selected_configuration(&core);
    assert!(
        !core
            .query_project_logs(&session.id, &project_query)
            .unwrap()
            .rows
            .is_empty()
    );
    assert!(
        !core
            .query_standalone_logs(&session.id, &query)
            .unwrap()
            .rows
            .is_empty()
    );
    assert_eq!(selected_configuration(&core), configured);
    project_query.source_ids = vec![old_id.clone()];
    assert!(
        core.query_project_logs(&session.id, &project_query)
            .unwrap()
            .rows
            .is_empty()
    );
    let mut foreign = standalone_query_for(&compose_id);
    foreign.time_from = query.time_from.clone();
    assert!(
        core.query_standalone_logs(&session.id, &foreign)
            .unwrap()
            .rows
            .is_empty()
    );
    wait_for(
        || {
            (owned.inspect(&compose_id, false)["State"]["Health"]["Status"] == "healthy")
                .then_some(())
        },
        "Compose health restored",
    );
    owned.mutate(&new_id, true, &["container", "rm", "--force", &new_id]);
    owned.created.clear(); // Both additional incarnations were removed by exact ID.
    let label = format!("label={CHILD_LABEL}={}", owned.nonce);
    owned.core.verify(&owned.target).unwrap();
    let remaining = owned
        .core
        .docker(
            &owned.target,
            &[
                "container",
                "ls",
                "--all",
                "--no-trunc",
                "--filter",
                &label,
                "--format",
                "{{.ID}}",
            ],
            15,
        )
        .unwrap();
    assert!(
        String::from_utf8(remaining).unwrap().trim().is_empty(),
        "additional validation containers remain"
    );
    println!(
        "{}",
        serde_json::json!({"run":owned.owner, "standaloneOldId":old_id,
        "standaloneNewId":new_id, "composeId":compose_id, "standaloneEvent":incident.occurred_at,
        "composeEvent":compose_event.occurred_at, "oldRetainedRows":old_retained.rows.len(),
        "standaloneResources":true, "composeResources":true, "cleanup":"additional labelled containers removed; Compose healthy"})
    );
}
