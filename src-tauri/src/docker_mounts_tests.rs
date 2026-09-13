use super::*;

fn selected(fixture: &Fixture) -> (String, ContainerList) {
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    (id, list)
}
fn mount_calls(fixture: &Fixture) -> Vec<Value> {
    fixture
        .trace()
        .into_iter()
        .filter(|row| {
            row["args"]
                .as_array()
                .unwrap()
                .iter()
                .any(|arg| arg.as_str().is_some_and(|arg| arg.contains("\"Mounts\"")))
        })
        .collect()
}
fn wait_mounts(fixture: &Fixture) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !fixture.dir.join("reading-mounts").exists() {
        assert!(
            Instant::now() < deadline,
            "mount fixture did not begin reading"
        );
        thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn mount_inventory_batches_all_ids_including_stopped_and_caches_across_generation() {
    let fixture = Fixture::new();
    fixture.states(&vec!["exited"; 201]);
    let (id, list) = selected(&fixture);
    fixture.choose("context-B");
    let first = fixture.core.get_mount_inventory(&id, false).unwrap();
    assert_eq!(first.coverage, "complete");
    assert_eq!(first.containers.len(), 201);
    assert!(
        first
            .containers
            .iter()
            .all(|row| row.mounts_available && row.mounts.len() == 2)
    );
    let calls = mount_calls(&fixture);
    assert_eq!(calls.len(), 3);
    assert_eq!(
        calls
            .iter()
            .map(|call| call["args"].as_array().unwrap().len() - 6)
            .collect::<Vec<_>>(),
        [100, 100, 1]
    );
    assert!(
        calls
            .iter()
            .all(|call| call["args"][1] == fixture.endpoint("A"))
    );
    let second_list = fixture.core.list_containers(&id).unwrap();
    assert!(second_list.generation > list.generation);
    let cached = fixture.core.get_mount_inventory(&id, false).unwrap();
    assert_eq!(cached.observed_at, first.observed_at);
    assert_eq!(mount_calls(&fixture).len(), 3);
    fixture.core.get_mount_inventory(&id, true).unwrap();
    assert_eq!(mount_calls(&fixture).len(), 6);
    fixture.states(&["exited"]);
    fixture.core.list_containers(&id).unwrap();
    assert_eq!(
        fixture
            .core
            .get_mount_inventory(&id, false)
            .unwrap()
            .containers
            .len(),
        1
    );
    assert_eq!(mount_calls(&fixture).len(), 7);
    assert_eq!(fixture.mutations(), 0);
}
#[test]
fn unavailable_mount_batches_keep_every_requested_id_and_do_not_cache_partial_results() {
    let fixture = Fixture::new();
    fixture.states(&["running", "exited"]);
    let (id, list) = selected(&fixture);
    for mode in [
        "mounts_fail",
        "mounts_wrong_id",
        "mounts_duplicate",
        "mounts_missing",
        "mounts_unavailable",
    ] {
        fixture.mode(mode);
        let result = fixture.core.get_mount_inventory(&id, false).unwrap();
        assert_eq!(result.coverage, "partial", "{mode}");
        assert_eq!(result.containers.len(), list.containers.len());
        assert!(result.containers.iter().all(|row| !row.mounts_available));
    }
    assert_eq!(mount_calls(&fixture).len(), 5);
    fixture.mode("");
    assert_eq!(
        fixture
            .core
            .get_mount_inventory(&id, false)
            .unwrap()
            .coverage,
        "complete"
    );
    assert_eq!(mount_calls(&fixture).len(), 6);
}
#[test]
fn mount_read_is_single_flight_without_blocking_inventory_and_changed_ids_are_partial() {
    let fixture = Fixture::new();
    let (id, _) = selected(&fixture);
    fixture.mode("held_mounts");
    let core = fixture.core.clone();
    let requested = id.clone();
    let child = thread::spawn(move || core.get_mount_inventory(&requested, false));
    wait_mounts(&fixture);
    assert_eq!(
        fixture
            .core
            .get_mount_inventory(&id, true)
            .unwrap_err()
            .code,
        "Busy"
    );
    fixture.states(&["running", "exited"]);
    fixture.core.fetch_observed_inventory(&id).unwrap();
    fs::write(fixture.dir.join("release-mounts"), "1").unwrap();
    let result = child.join().unwrap().unwrap();
    assert_eq!(result.coverage, "partial");
    assert_eq!(result.containers.len(), 2);
    assert_eq!(
        result
            .containers
            .iter()
            .filter(|row| row.mounts_available)
            .count(),
        1
    );
    fixture.mode("");
    assert_eq!(
        fixture
            .core
            .get_mount_inventory(&id, false)
            .unwrap()
            .coverage,
        "complete"
    );
}
#[test]
fn reconnect_cancels_quiet_mount_child_and_rejects_late_result() {
    let fixture = Fixture::new();
    let (id, _) = selected(&fixture);
    fixture.mode("held_mounts");
    let core = fixture.core.clone();
    let child = thread::spawn(move || core.get_mount_inventory(&id, false));
    wait_mounts(&fixture);
    let next = fixture.connect();
    assert_eq!(child.join().unwrap().unwrap_err().code, "StaleSession");
    fixture.mode("");
    fixture.core.list_containers(&next).unwrap();
    assert_eq!(
        fixture
            .core
            .get_mount_inventory(&next, false)
            .unwrap()
            .coverage,
        "complete"
    );
    assert!(!fixture.dir.join("release-mounts").exists());
}
#[test]
fn mount_deadline_and_cumulative_output_budget_return_partial_inventory() {
    let mut fixture = Fixture::new();
    fixture.core.mount_timeout = Some(Duration::from_secs(2));
    let (id, _) = selected(&fixture);
    fixture.mode("held_mounts");
    let started = Instant::now();
    let result = fixture.core.get_mount_inventory(&id, false).unwrap();
    assert_eq!(result.coverage, "partial");
    assert!(!result.containers[0].mounts_available);
    assert!(started.elapsed() < Duration::from_secs(6));
    fixture.mode("");
    fixture.core.mount_timeout = None;
    fixture.core.mount_output_limit = Some(32_000);
    fixture.states(&vec!["exited"; 201]);
    fixture.core.list_containers(&id).unwrap();
    let result = fixture.core.get_mount_inventory(&id, true).unwrap();
    assert_eq!(result.coverage, "partial");
    assert_eq!(result.containers.len(), 201);
    assert_eq!(
        result
            .containers
            .iter()
            .filter(|row| row.mounts_available)
            .count(),
        100
    );
}
#[test]
fn mount_identity_failures_invalidate_session_and_never_expose_raw_output() {
    let fixture = Fixture::new();
    let (id, _) = selected(&fixture);
    fixture.mode("engine_changed");
    assert_eq!(
        fixture
            .core
            .get_mount_inventory(&id, false)
            .unwrap_err()
            .code,
        "EnvironmentChanged"
    );
    assert!(mount_calls(&fixture).is_empty());
    assert!(fixture.core.active(&id).unwrap().needs_validation);
    fixture.mode("");
    let (id, _) = selected(&fixture);
    fixture.mode("mounts_denied");
    let error = fixture.core.get_mount_inventory(&id, false).unwrap_err();
    assert_eq!(error.code, "PermissionDenied");
    assert!(error.command.is_none() && error.stderr.is_none());
}
#[test]
fn inventory_health_configuration_is_independent_of_runtime_health() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    for (value, expected) in [
        (serde_json::json!(true), Some(true)),
        (serde_json::json!(false), Some(false)),
        (Value::Null, None),
        (serde_json::json!("false"), None),
    ] {
        fs::write(fixture.dir.join("health-configured"), value.to_string()).unwrap();
        let list = fixture.core.list_containers(&id).unwrap();
        assert_eq!(list.containers[0].health_configured, expected);
        assert_eq!(list.containers[0].health.as_deref(), Some("none"));
    }
}

#[test]
fn mount_inventory_requires_current_valid_session_and_handles_empty_inventory() {
    let fixture = Fixture::new();
    assert_eq!(
        fixture
            .core
            .get_mount_inventory("old-session", false)
            .unwrap_err()
            .code,
        "StaleSession"
    );
    let id = fixture.connect();
    assert_eq!(
        fixture
            .core
            .get_mount_inventory(&id, false)
            .unwrap_err()
            .code,
        "NeedsValidation"
    );
    fixture.states(&[]);
    fixture.core.list_containers(&id).unwrap();
    let result = fixture.core.get_mount_inventory(&id, false).unwrap();
    assert_eq!(result.coverage, "complete");
    assert!(result.containers.is_empty());
    assert!(mount_calls(&fixture).is_empty());
}
