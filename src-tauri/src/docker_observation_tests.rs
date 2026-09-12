use super::*;

#[path = "docker_live_observation_test.rs"]
mod live;

fn wait_until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !ready() {
        assert!(
            Instant::now() < deadline,
            "observation fixture did not make progress"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn observation_refresh_waits_for_an_inflight_stream_start() {
    let fixture = Fixture::new();
    fixture.states(&["running"]);
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    fixture.mode("held_info");
    let core = fixture.core.clone();
    let request_id = id.clone();
    let generation = list.generation;
    let handle = list.containers[0].handle.clone();
    let start = thread::spawn(move || core.start_log_stream(&request_id, generation, &handle));
    wait_until(|| fixture.dir.join("verifying").exists());

    fixture
        .core
        .configure_observation(&id, ObservationScope::All)
        .unwrap();
    // Check the atomic reservation too: the worker's earlier busy snapshot is
    // insufficient when a log start acquires the state lock immediately after it.
    assert_eq!(
        fixture.core.fetch_observed_inventory(&id).unwrap_err().code,
        "Busy"
    );
    assert_eq!(fixture.core.active(&id).unwrap().generation, generation);
    assert!(fixture.core.state.lock().unwrap().stream_starting);
    assert!(!fixture.core.state.lock().unwrap().refreshing);

    fixture.mode("");
    fs::write(fixture.dir.join("release-info"), "1").unwrap();
    let stream = start.join().unwrap().unwrap();
    wait_until(|| fixture.dir.join("following").exists());
    wait_until(|| {
        fixture
            .core
            .read_observation(&id, 0)
            .unwrap()
            .inventory
            .is_some_and(|inventory| inventory.generation > generation)
    });
    assert!(!fixture.core.state.lock().unwrap().stream_starting);
    assert!(
        !fixture
            .core
            .read_log_stream(&id, &stream.stream_id)
            .unwrap()
            .terminal
    );
    assert_eq!(stream.full_id, list.containers[0].full_id);
    assert_eq!(fixture.mutations(), 0);
    fixture.core.shutdown();
}

#[test]
fn observation_refresh_before_stream_start_requires_the_new_inventory() {
    let fixture = Fixture::new();
    fixture.states(&["running"]);
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    fixture.mode("held_inspect");
    fixture
        .core
        .configure_observation(&id, ObservationScope::All)
        .unwrap();
    wait_until(|| fixture.dir.join("inspecting").exists());
    assert_eq!(
        fixture
            .core
            .start_log_stream(&id, list.generation, &list.containers[0].handle)
            .unwrap_err()
            .code,
        "Busy"
    );
    assert!(!fixture.dir.join("following").exists());

    fixture.mode("");
    fs::write(fixture.dir.join("release-inspect"), "1").unwrap();
    wait_until(|| {
        fixture
            .core
            .read_observation(&id, 0)
            .unwrap()
            .inventory
            .is_some_and(|inventory| inventory.generation > list.generation)
    });
    let latest = fixture
        .core
        .read_observation(&id, 0)
        .unwrap()
        .inventory
        .unwrap();
    assert_eq!(
        fixture
            .core
            .start_log_stream(&id, list.generation, &list.containers[0].handle)
            .unwrap_err()
            .code,
        "StaleHandle"
    );
    assert!(!fixture.dir.join("following").exists());
    let stream = fixture
        .core
        .start_log_stream(&id, latest.generation, &latest.containers[0].handle)
        .unwrap();
    wait_until(|| fixture.dir.join("following").exists());
    assert_eq!(stream.full_id, list.containers[0].full_id);
    assert!(
        !fixture
            .core
            .read_log_stream(&id, &stream.stream_id)
            .unwrap()
            .terminal
    );
    assert_eq!(fixture.mutations(), 0);
    fixture.core.shutdown();
}

#[test]
fn background_stats_complete_before_a_coalesced_inventory_refresh() {
    let fixture = Fixture::new();
    fixture.states(&["running"]);
    let id = fixture.connect();
    fixture.core.list_containers(&id).unwrap();
    fixture.mode("held_stats");
    fixture
        .core
        .configure_observation(&id, ObservationScope::All)
        .unwrap();
    wait_until(|| fixture.dir.join("sampling").exists());
    let generation = fixture
        .core
        .read_observation(&id, 0)
        .unwrap()
        .inventory
        .unwrap()
        .generation;
    let core = fixture.core.clone();
    let request_id = id.clone();
    let refresh = thread::spawn(move || core.list_containers(&request_id));
    thread::sleep(Duration::from_millis(100));
    assert!(
        !refresh.is_finished(),
        "refresh must wait for the accepted sample"
    );
    assert_eq!(fixture.core.active(&id).unwrap().generation, generation);
    fs::write(fixture.dir.join("release-stats"), "1").unwrap();
    let snapshot = refresh.join().unwrap().unwrap();
    assert!(snapshot.generation > generation);
    // A queued manual refresh also yields one stats opportunity after every
    // inventory publication; repeated refresh clicks cannot starve history.
    for _ in 0..3 {
        fixture.core.list_containers(&id).unwrap();
    }
    let observed = fixture.core.read_observation(&id, 0).unwrap();
    assert!(
        observed
            .resources
            .iter()
            .filter(|point| point.available)
            .count()
            >= 4
    );
    assert!(
        observed
            .resources
            .iter()
            .any(|point| point.available && point.cpu_percent == Some(250.25))
    );
    assert!(
        observed
            .resources
            .iter()
            .any(|point| point.memory_usage_bytes == Some(13_107_200.0))
    );
    let later = fixture
        .core
        .read_observation(&id, observed.sequence)
        .unwrap();
    assert!(
        later
            .resources
            .iter()
            .all(|point| point.sequence > observed.sequence)
    );
    assert_eq!(fixture.mutations(), 0);
    fixture.core.shutdown();
}

#[test]
fn hold_waits_for_the_pending_inventory_and_returns_its_handles() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    fixture.core.list_containers(&id).unwrap();
    fixture.mode("held_inspect");
    fixture
        .core
        .configure_observation(&id, ObservationScope::All)
        .unwrap();
    wait_until(|| fixture.dir.join("inspecting").exists());
    assert_eq!(fixture.core.get_environment().unwrap_err().code, "Busy");
    assert!(
        fixture.core.observation.lock().unwrap().is_some(),
        "a refused reconnect must preserve the active observation worker"
    );
    let core = fixture.core.clone();
    let request_id = id.clone();
    let held = thread::spawn(move || core.hold_observation(&request_id));
    thread::sleep(Duration::from_millis(100));
    assert!(!held.is_finished());
    fs::write(fixture.dir.join("release-inspect"), "1").unwrap();
    let held = held.join().unwrap().unwrap();
    let current = fixture
        .core
        .read_observation(&id, 0)
        .unwrap()
        .inventory
        .unwrap();
    assert_eq!(held.inventory.generation, current.generation);
    assert_eq!(
        held.inventory.containers[0].handle,
        current.containers[0].handle
    );
    fixture
        .core
        .release_observation_hold(&id, &held.hold_id)
        .unwrap();
    fixture.core.shutdown();
}

#[test]
fn switching_observation_projects_preserves_previous_history_and_reconnect_clears_it() {
    let fixture = Fixture::new();
    fixture.states(&["running", "running"]);
    fixture.mode("compose");
    let id = fixture.connect();
    fixture.core.list_containers(&id).unwrap();
    fixture
        .core
        .configure_observation(
            &id,
            ObservationScope::Project {
                name: "team-dev".into(),
            },
        )
        .unwrap();
    wait_until(|| {
        !fixture
            .core
            .read_observation(&id, 0)
            .unwrap()
            .resources
            .is_empty()
    });
    let before = fixture.core.read_observation(&id, 0).unwrap();
    assert_eq!(before.resources.len(), 2);
    let changed = fixture
        .core
        .configure_observation(
            &id,
            ObservationScope::Project {
                name: "absent".into(),
            },
        )
        .unwrap();
    assert_eq!(changed.resources.len(), before.resources.len() + 2);
    assert!(
        changed
            .resources
            .iter()
            .take(before.resources.len())
            .zip(&before.resources)
            .all(|(current, previous)| current.sequence == previous.sequence)
    );
    assert!(
        changed
            .resources
            .iter()
            .skip(before.resources.len())
            .all(|point| !point.available)
    );
    assert!(matches!(changed.scope, ObservationScope::Project { name } if name == "absent"));
    let new_id = fixture.core.get_environment().unwrap().session_id.unwrap();
    assert_ne!(new_id, id);
    assert_eq!(
        fixture.core.read_observation(&id, 0).unwrap_err().code,
        "StaleSession"
    );
    assert!(fixture.core.observation.lock().unwrap().is_none());
    fixture.core.shutdown();
}
