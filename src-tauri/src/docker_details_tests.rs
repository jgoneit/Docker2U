use super::*;

fn selected(fixture: &Fixture) -> (String, ContainerList) {
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    (id, list)
}

fn read(fixture: &Fixture, id: &str, list: &ContainerList) -> ContainerDetails {
    fixture
        .core
        .get_container_details(id, list.generation, &list.containers[0].handle)
        .unwrap()
}

fn details_calls(fixture: &Fixture) -> Vec<Value> {
    fixture
        .trace()
        .into_iter()
        .filter(|row| {
            row["args"].as_array().unwrap().iter().any(|arg| {
                arg.as_str()
                    .is_some_and(|arg| arg.contains("\"OOMKilled\""))
            })
        })
        .collect()
}

#[test]
fn selected_details_pin_one_full_id_and_do_not_update_inventory_authority() {
    let fixture = Fixture::new();
    fixture.states(&["exited", "running"]);
    let (id, list) = selected(&fixture);
    fixture.choose("context-B");
    let details = read(&fixture, &id, &list);
    assert_eq!(details.session_id, id);
    assert_eq!(details.generation, list.generation);
    assert_eq!(details.handle, list.containers[0].handle);
    assert_eq!(details.full_id, list.containers[0].full_id);
    assert_eq!(details.diagnostics.exit_code, Some(137));
    assert_eq!(details.diagnostics.oom_killed, Some(true));
    assert_eq!(details.diagnostics.restart_count, Some(2));
    assert!(details.diagnostics.health_available);
    assert_eq!(details.diagnostics.health_configured, Some(false));
    assert!(details.diagnostics.health.is_none());
    assert!(chrono::DateTime::parse_from_rfc3339(&details.observed_at).is_ok());
    let calls = details_calls(&fixture);
    assert_eq!(calls.len(), 1);
    let args = calls[0]["args"].as_array().unwrap();
    assert_eq!(args.len(), 7);
    assert_eq!(args[1], fixture.endpoint("A"));
    assert_eq!(args[6], list.containers[0].full_id);
    let format = args[5].as_str().unwrap();
    for forbidden in [
        "{{json .}}",
        "Config.Env",
        "Config.Labels",
        "HostConfig}}",
        "NetworkSettings}}",
    ] {
        assert!(
            !format.contains(forbidden),
            "projected unrelated field: {forbidden}"
        );
    }
    let active = fixture.core.active(&id).unwrap();
    assert_eq!(active.generation, list.generation);
    assert!(active.handles.contains_key(&list.containers[0].handle));
    assert!(!active.stale && !active.needs_validation);
    assert_eq!(fixture.mutations(), 0);
}

#[test]
fn details_reject_stale_identity_before_dispatch() {
    let fixture = Fixture::new();
    let (id, list) = selected(&fixture);
    let handle = &list.containers[0].handle;
    for (session, generation, handle, code) in [
        (
            "old-session",
            list.generation,
            handle.as_str(),
            "StaleSession",
        ),
        (
            id.as_str(),
            list.generation + 1,
            handle.as_str(),
            "StaleHandle",
        ),
        (id.as_str(), list.generation, "not-a-handle", "StaleHandle"),
    ] {
        assert_eq!(
            fixture
                .core
                .get_container_details(session, generation, handle)
                .unwrap_err()
                .code,
            code
        );
    }
    fixture
        .core
        .state
        .lock()
        .unwrap()
        .session
        .as_mut()
        .unwrap()
        .stale = true;
    assert_eq!(
        fixture
            .core
            .get_container_details(&id, list.generation, handle)
            .unwrap_err()
            .code,
        "NeedsValidation"
    );
    assert!(details_calls(&fixture).is_empty());
}

#[test]
fn wrong_duplicate_missing_and_failed_details_preserve_inventory_gate() {
    let fixture = Fixture::new();
    let (id, list) = selected(&fixture);
    for mode in [
        "details_wrong_id",
        "details_duplicate",
        "details_missing",
        "details_fail",
    ] {
        fixture.mode(mode);
        let error = fixture
            .core
            .get_container_details(&id, list.generation, &list.containers[0].handle)
            .unwrap_err();
        assert_eq!(
            error.code,
            if mode == "details_fail" {
                "CommandFailed"
            } else {
                "MalformedOutput"
            }
        );
        let active = fixture.core.active(&id).unwrap();
        assert_eq!(active.generation, list.generation);
        assert!(!active.stale && !active.needs_validation);
        assert!(!fixture.core.state.lock().unwrap().details_running);
    }
    assert_eq!(fixture.mutations(), 0);
}

fn wait_for_details(fixture: &Fixture) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !fixture.dir.join("reading-details").exists() {
        assert!(
            Instant::now() < deadline,
            "details fixture did not reach inspect"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn held_details_do_not_block_refresh_and_discard_the_old_generation() {
    let fixture = Fixture::new();
    let (id, list) = selected(&fixture);
    fixture.mode("held_details");
    let core = fixture.core.clone();
    let request_id = id.clone();
    let handle = list.containers[0].handle.clone();
    let child =
        thread::spawn(move || core.get_container_details(&request_id, list.generation, &handle));
    wait_for_details(&fixture);
    assert_eq!(
        fixture
            .core
            .get_container_details(&id, list.generation, &list.containers[0].handle)
            .unwrap_err()
            .code,
        "Busy"
    );
    fixture.core.list_containers(&id).unwrap();
    fs::write(fixture.dir.join("release-details"), "1").unwrap();
    assert_eq!(child.join().unwrap().unwrap_err().code, "StaleHandle");
    assert!(!fixture.core.state.lock().unwrap().details_running);
}

#[test]
fn held_details_discard_a_reconnected_session() {
    let fixture = Fixture::new();
    let (id, list) = selected(&fixture);
    fixture.mode("held_details");
    let core = fixture.core.clone();
    let child = thread::spawn(move || {
        core.get_container_details(&id, list.generation, &list.containers[0].handle)
    });
    wait_for_details(&fixture);
    let environment = fixture.core.get_environment().unwrap();
    assert_eq!(environment.status, "ready");
    fs::write(fixture.dir.join("release-details"), "1").unwrap();
    assert_eq!(child.join().unwrap().unwrap_err().code, "StaleSession");
}

#[test]
fn held_details_do_not_block_mutation_or_accept_its_stale_inventory() {
    let fixture = Fixture::new();
    let (id, list) = selected(&fixture);
    fixture.mode("held_details");
    let core = fixture.core.clone();
    let request_id = id.clone();
    let handle = list.containers[0].handle.clone();
    let child =
        thread::spawn(move || core.get_container_details(&request_id, list.generation, &handle));
    wait_for_details(&fixture);
    let result = fixture
        .core
        .mutate_container(&id, &list.containers[0].handle, Action::Start)
        .unwrap();
    assert_eq!(result.outcome, "succeeded");
    assert!(fixture.core.active(&id).unwrap().stale);
    fs::write(fixture.dir.join("release-details"), "1").unwrap();
    assert_eq!(child.join().unwrap().unwrap_err().code, "StaleHandle");
}

#[test]
fn engine_identity_failures_invalidate_the_shared_session_without_inspect() {
    let fixture = Fixture::new();
    let (id, list) = selected(&fixture);
    fixture.mode("engine_changed");
    assert_eq!(
        fixture
            .core
            .get_container_details(&id, list.generation, &list.containers[0].handle)
            .unwrap_err()
            .code,
        "EnvironmentChanged"
    );
    assert!(details_calls(&fixture).is_empty());
    let active = fixture.core.active(&id).unwrap();
    assert!(active.stale && active.needs_validation);
    assert_eq!(active.generation, list.generation);
    assert_eq!(fixture.mutations(), 0);
}

/// Reads one existing container through the production Core projection. Never
/// creates, starts, stops, restarts, execs in or removes a real container.
#[test]
#[ignore = "Read-only selected-container probe; requires DOCKER2U_REAL_DETAILS_PROBE=1"]
fn real_container_details_probe() {
    assert_eq!(
        std::env::var("DOCKER2U_REAL_DETAILS_PROBE").as_deref(),
        Ok("1")
    );
    let core = Core::default();
    let environment = core.get_environment().unwrap();
    assert_eq!(environment.status, "ready", "{environment:?}");
    let id = environment.session_id.as_deref().unwrap();
    let list = core.list_containers(id).unwrap();
    let container = list
        .containers
        .first()
        .expect("Read-only details probe needs an existing container");
    let details = core
        .get_container_details(id, list.generation, &container.handle)
        .unwrap();
    assert_eq!(details.session_id, id);
    assert_eq!(details.generation, list.generation);
    assert_eq!(details.handle, container.handle);
    assert_eq!(details.full_id, container.full_id);
    assert!(chrono::DateTime::parse_from_rfc3339(&details.observed_at).is_ok());
    assert!(details.diagnostics.health_configured.is_some());
    assert!(details.diagnostics.health_available);
    assert!(details.connectivity.ports_available);
    assert!(details.connectivity.networks_available);
    if let Some(health) = &details.diagnostics.health {
        assert!(health.recent_failures.len() <= 3);
        for failure in &health.recent_failures {
            assert_ne!(failure.exit_code, 0);
            assert!(failure.output.len() <= 4 * 1024);
        }
    }
    let session = core.active(id).unwrap();
    assert_eq!(session.generation, list.generation);
    assert!(!session.stale && !session.needs_validation);
    // The record reports only structural evidence, not Health output, addresses,
    // names, environment variables or labels from a user's workload.
    eprintln!(
        "read-only details: one full ID verified; generation {}; observed {}; state {}; health configured {:?}; ports {}; networks {}; inventory {}",
        details.generation,
        details.observed_at,
        details.diagnostics.state,
        details.diagnostics.health_configured,
        details.connectivity.ports.len(),
        details.connectivity.networks.len(),
        list.containers.len()
    );
}
