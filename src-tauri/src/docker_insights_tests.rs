use super::*;

#[path = "docker_live_insights_test.rs"]
mod live;

fn wait_file(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "fixture did not reach {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn compose_labels_are_optional_and_projected_without_other_labels() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    let plain = fixture.core.list_containers(&id).unwrap();
    assert!(plain.containers[0].compose_project.is_none());
    fixture.mode("compose");
    let compose = fixture.core.list_containers(&id).unwrap();
    assert_eq!(
        compose.containers[0].compose_project.as_deref(),
        Some("team-dev")
    );
    assert_eq!(
        compose.containers[0].compose_service.as_deref(),
        Some("api")
    );
    assert!(INSPECT_FORMAT.contains("com.docker.compose.project"));
    assert!(INSPECT_FORMAT.contains("com.docker.compose.service"));
    assert!(!INSPECT_FORMAT.contains("{{json .Config.Labels}}"));
}

#[test]
fn stats_batch_only_requested_running_full_ids_and_preserve_cli_values() {
    let fixture = Fixture::new();
    fixture.states(&["running", "running", "exited"]);
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    let handles: Vec<_> = list
        .containers
        .iter()
        .map(|container| container.handle.clone())
        .collect();
    fixture.choose("context-B");
    let sample = fixture
        .core
        .get_container_stats(&id, list.generation, &handles)
        .unwrap();
    assert_eq!(sample.items.len(), 3);
    assert_eq!(sample.items[0].cpu_percent, Some(250.25));
    assert_eq!(
        sample.items[0].memory_usage.as_deref(),
        Some("12.5MiB / 2GiB")
    );
    assert!(!sample.items[2].available);
    assert!(sample.items[2].cpu_percent.is_none());
    let calls: Vec<_> = fixture
        .trace()
        .into_iter()
        .filter(|row| {
            row["args"]
                .as_array()
                .unwrap()
                .iter()
                .any(|arg| arg == "stats")
        })
        .collect();
    assert_eq!(calls.len(), 1);
    let arguments = calls[0]["args"].as_array().unwrap();
    assert_eq!(arguments[1], fixture.endpoint("A"));
    assert_eq!(arguments.len(), 10);
    assert_eq!(arguments[8], list.containers[0].full_id);
    assert_eq!(arguments[9], list.containers[1].full_id);
    assert_eq!(fixture.mutations(), 0);
}

#[test]
fn stats_bounds_each_cli_batch_to_one_hundred_ids() {
    let fixture = Fixture::new();
    fixture.states(&vec!["running"; 101]);
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    let handles: Vec<_> = list
        .containers
        .iter()
        .map(|container| container.handle.clone())
        .collect();
    let result = fixture
        .core
        .get_container_stats(&id, list.generation, &handles)
        .unwrap();
    assert!(result.error.is_none());
    assert_eq!(
        result.items.iter().filter(|item| item.available).count(),
        101
    );
    let trace = fixture.trace();
    let calls: Vec<_> = trace
        .iter()
        .filter(|row| {
            row["args"]
                .as_array()
                .unwrap()
                .iter()
                .any(|arg| arg == "stats")
        })
        .collect();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["args"].as_array().unwrap().len(), 108);
    assert_eq!(calls[1]["args"].as_array().unwrap().len(), 9);
}

#[test]
fn empty_stopped_duplicate_and_stale_stats_requests_do_not_dispatch_stats() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    let handle = list.containers[0].handle.clone();
    assert!(
        fixture
            .core
            .get_container_stats(&id, list.generation, &[])
            .unwrap()
            .items
            .is_empty()
    );
    assert!(
        !fixture
            .core
            .get_container_stats(&id, list.generation, std::slice::from_ref(&handle))
            .unwrap()
            .items[0]
            .available
    );
    assert_eq!(
        fixture
            .core
            .get_container_stats(&id, list.generation, &[handle.clone(), handle.clone()])
            .unwrap_err()
            .code,
        "InvalidSelection"
    );
    assert_eq!(
        fixture
            .core
            .get_container_stats(&id, list.generation + 1, &[handle])
            .unwrap_err()
            .code,
        "StaleHandle"
    );
    assert!(!fixture.trace().iter().any(|row| {
        row["args"]
            .as_array()
            .unwrap()
            .iter()
            .any(|arg| arg == "stats")
    }));
}

#[test]
fn stats_failures_do_not_grant_or_remove_mutation_authority() {
    let fixture = Fixture::new();
    fixture.states(&["running"]);
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    fixture.mode("stats_fail");
    let result = fixture
        .core
        .get_container_stats(&id, list.generation, &[list.containers[0].handle.clone()])
        .unwrap();
    assert!(!result.items[0].available);
    assert_eq!(result.error.unwrap().code, "CommandFailed");
    assert!(!fixture.core.active(&id).unwrap().needs_validation);
    assert!(!fixture.core.active(&id).unwrap().stale);
    fixture.mode("wrong_stats_id");
    let result = fixture
        .core
        .get_container_stats(&id, list.generation, &[list.containers[0].handle.clone()])
        .unwrap();
    assert_eq!(result.error.unwrap().code, "MalformedOutput");
    assert!(!result.items[0].available);
    fixture.mode("duplicate_stats_id");
    let result = fixture
        .core
        .get_container_stats(&id, list.generation, &[list.containers[0].handle.clone()])
        .unwrap();
    assert_eq!(result.error.unwrap().code, "MalformedOutput");
    assert!(!result.items[0].available);
    fixture.mode("stats_missing");
    let result = fixture
        .core
        .get_container_stats(&id, list.generation, &[list.containers[0].handle.clone()])
        .unwrap();
    assert!(result.error.is_none());
    assert!(!result.items[0].available);
}

#[test]
fn held_stats_reject_overlap_and_discard_an_older_generation() {
    let fixture = Fixture::new();
    fixture.states(&["running"]);
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    fixture.mode("held_stats");
    let core = fixture.core.clone();
    let request_id = id.clone();
    let handle = list.containers[0].handle.clone();
    let child =
        thread::spawn(move || core.get_container_stats(&request_id, list.generation, &[handle]));
    wait_file(&fixture.dir.join("sampling"));
    assert_eq!(
        fixture
            .core
            .get_container_stats(&id, list.generation, &[])
            .unwrap_err()
            .code,
        "Busy"
    );
    fixture.core.list_containers(&id).unwrap();
    fs::write(fixture.dir.join("release-stats"), "1").unwrap();
    assert_eq!(child.join().unwrap().unwrap_err().code, "StaleHandle");
    assert!(!fixture.core.state.lock().unwrap().stats_running);
}

#[test]
fn log_stream_binds_full_id_across_refresh_and_stops_idempotently() {
    let fixture = Fixture::new();
    fixture.states(&["running"]);
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    let stream = fixture
        .core
        .start_log_stream(&id, list.generation, &list.containers[0].handle)
        .unwrap();
    wait_file(&fixture.dir.join("following"));
    let chunk = fixture
        .core
        .read_log_stream(&id, &stream.stream_id)
        .unwrap();
    assert_eq!(chunk.sequence, 1);
    let mut text = chunk.text;
    let mut sequence = chunk.sequence;
    let deadline = Instant::now() + Duration::from_secs(3);
    while !text.contains("hello red") {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
        let next = fixture
            .core
            .read_log_stream(&id, &stream.stream_id)
            .unwrap();
        assert_eq!(next.sequence, sequence + 1);
        sequence = next.sequence;
        text.push_str(&next.text);
    }
    assert!(!text.contains('\u{1b}'));
    assert!(!chunk.terminal);
    let refreshed = fixture.core.list_containers(&id).unwrap();
    assert_ne!(refreshed.containers[0].handle, list.containers[0].handle);
    let next = fixture
        .core
        .read_log_stream(&id, &stream.stream_id)
        .unwrap();
    assert_eq!(next.sequence, sequence + 1);
    assert!(!next.terminal);
    fixture
        .core
        .stop_log_stream(&id, "other-subscription")
        .unwrap();
    assert!(
        !fixture
            .core
            .read_log_stream(&id, &stream.stream_id)
            .unwrap()
            .terminal
    );
    fixture
        .core
        .stop_log_stream(&id, &stream.stream_id)
        .unwrap();
    fixture
        .core
        .stop_log_stream(&id, &stream.stream_id)
        .unwrap();
    assert_eq!(
        fixture
            .core
            .read_log_stream(&id, &stream.stream_id)
            .unwrap_err()
            .code,
        "StaleHandle"
    );
}

#[test]
fn reconnect_terminates_the_previous_subscription() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    let stream = fixture
        .core
        .start_log_stream(&id, list.generation, &list.containers[0].handle)
        .unwrap();
    wait_file(&fixture.dir.join("following"));
    let pid: i32 = fs::read_to_string(fixture.dir.join("following"))
        .unwrap()
        .parse()
        .unwrap();
    fixture.core.get_environment().unwrap();
    assert_eq!(
        fixture
            .core
            .read_log_stream(&id, &stream.stream_id)
            .unwrap_err()
            .code,
        "StaleSession"
    );
    // SAFETY: signal zero only observes the fixture's known child pid.
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
}

#[test]
fn stream_watchdog_catches_engine_replacement_without_frontend_reads() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    let stream = fixture
        .core
        .start_log_stream(&id, list.generation, &list.containers[0].handle)
        .unwrap();
    wait_file(&fixture.dir.join("following"));
    fixture.mode("engine_changed");
    let deadline = Instant::now() + Duration::from_secs(9);
    while !fixture.core.active(&id).unwrap().needs_validation {
        assert!(
            Instant::now() < deadline,
            "watchdog did not invalidate replacement Engine"
        );
        thread::sleep(Duration::from_millis(20));
    }
    loop {
        let result = fixture
            .core
            .read_log_stream(&id, &stream.stream_id)
            .unwrap();
        if result.terminal {
            assert_eq!(result.error.unwrap().code, "EnvironmentChanged");
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn reconnect_during_stream_validation_cannot_publish_or_launch_the_old_stream() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    fixture.mode("held_info");
    let core = fixture.core.clone();
    let request_id = id.clone();
    let handle = list.containers[0].handle.clone();
    let child = thread::spawn(move || core.start_log_stream(&request_id, list.generation, &handle));
    wait_file(&fixture.dir.join("verifying"));
    assert_eq!(
        fixture
            .core
            .start_log_stream(&id, list.generation, &list.containers[0].handle)
            .unwrap_err()
            .code,
        "Busy"
    );
    fixture.mode("");
    fixture.core.get_environment().unwrap();
    fs::write(fixture.dir.join("release-info"), "1").unwrap();
    assert_eq!(child.join().unwrap().unwrap_err().code, "StaleHandle");
    assert!(!fixture.dir.join("following").exists());
    assert!(!fixture.core.state.lock().unwrap().stream_starting);
}

#[test]
fn stats_identity_failure_cancels_live_logs_and_requires_reconnect() {
    let fixture = Fixture::new();
    fixture.states(&["running"]);
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    let handle = list.containers[0].handle.clone();
    let stream = fixture
        .core
        .start_log_stream(&id, list.generation, &handle)
        .unwrap();
    wait_file(&fixture.dir.join("following"));
    fixture.mode("engine_changed");
    assert_eq!(
        fixture
            .core
            .get_container_stats(&id, list.generation, &[handle])
            .unwrap_err()
            .code,
        "EnvironmentChanged"
    );
    assert!(fixture.core.active(&id).unwrap().needs_validation);
    let result = fixture
        .core
        .read_log_stream(&id, &stream.stream_id)
        .unwrap();
    assert!(result.terminal);
    assert_eq!(result.error.unwrap().code, "EnvironmentChanged");
}
