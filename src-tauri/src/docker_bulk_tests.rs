use super::*;

fn handles(list: &ContainerList) -> Vec<String> {
    list.containers
        .iter()
        .map(|container| container.handle.clone())
        .collect()
}

fn outcomes(result: &BulkMutation) -> Vec<&str> {
    result
        .items
        .iter()
        .map(|item| item.outcome.as_str())
        .collect()
}

#[test]
fn each_bulk_action_dispatches_exact_ids_once_in_selection_order() {
    for (action, initial, expected) in [
        (Action::Start, "exited", "running"),
        (Action::Stop, "running", "exited"),
        (Action::Restart, "running", "running"),
    ] {
        let fixture = Fixture::new();
        fixture.states(&[initial, initial, initial]);
        let id = fixture.connect();
        let list = fixture.core.list_containers(&id).unwrap();
        let selected = handles(&list);
        let result = fixture
            .core
            .mutate_containers(&id, list.generation, &selected, action)
            .unwrap();
        assert_eq!(outcomes(&result), ["succeeded", "succeeded", "succeeded"]);
        assert!(!result.mutation_blocked);
        assert_eq!(
            result
                .items
                .iter()
                .map(|item| &item.handle)
                .collect::<Vec<_>>(),
            selected.iter().collect::<Vec<_>>()
        );
        let calls: Vec<_> = fixture
            .trace()
            .into_iter()
            .filter(|row| row["args"][3] == action.name())
            .collect();
        assert_eq!(calls.len(), 3);
        for (call, container) in calls.iter().zip(&list.containers) {
            assert_eq!(call["args"].as_array().unwrap().len(), 5);
            assert_eq!(call["args"][4], container.full_id);
        }
        for item in &result.items {
            assert_eq!(
                item.result.as_ref().unwrap().observed_state.as_deref(),
                Some(expected)
            );
            assert!(item.error.is_none());
        }
        assert!(!fixture.core.state.lock().unwrap().mutating);
        assert!(fixture.core.active(&id).unwrap().stale);
        let next = fixture.core.list_containers(&id).unwrap();
        assert_eq!(next.generation, list.generation + 1);
        assert!(
            next.containers
                .iter()
                .all(|container| !selected.contains(&container.handle))
        );
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["sessionId"], id);
        assert_eq!(json["generation"], list.generation);
        assert_eq!(json["action"], action.name());
        assert_eq!(json["items"][0]["fullId"], list.containers[0].full_id);
    }
}

#[test]
fn request_validation_is_atomic_and_does_not_invalidate_the_list() {
    let fixture = Fixture::new();
    fixture.states(&["exited", "exited"]);
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    let handle = list.containers[0].handle.clone();
    for (session, generation, selected, code) in [
        (id.as_str(), list.generation, vec![], "InvalidSelection"),
        (
            id.as_str(),
            list.generation,
            vec![handle.clone(), handle.clone()],
            "InvalidSelection",
        ),
        (
            id.as_str(),
            list.generation,
            vec![handle.clone(), "unknown-handle".into()],
            "StaleHandle",
        ),
        (
            id.as_str(),
            list.generation + 1,
            vec![handle.clone()],
            "StaleHandle",
        ),
        (
            "old-session",
            list.generation,
            vec![handle.clone()],
            "StaleSession",
        ),
    ] {
        let trace = fixture.trace();
        assert_eq!(
            fixture
                .core
                .mutate_containers(session, generation, &selected, Action::Start)
                .unwrap_err()
                .code,
            code
        );
        assert_eq!(fixture.trace(), trace);
        let state = fixture.core.state.lock().unwrap();
        assert!(!state.mutating);
        assert!(!state.session.as_ref().unwrap().stale);
    }
    let refreshed = fixture.core.list_containers(&id).unwrap();
    assert_eq!(
        fixture
            .core
            .mutate_containers(&id, refreshed.generation, &[handle], Action::Start)
            .unwrap_err()
            .code,
        "StaleHandle"
    );
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
            .mutate_containers(
                &id,
                refreshed.generation,
                &handles(&refreshed),
                Action::Start
            )
            .unwrap_err()
            .code,
        "NeedsValidation"
    );
    assert_eq!(fixture.mutations(), 0);
}

#[test]
fn initial_eligibility_is_frozen_and_newly_ineligible_items_are_skipped() {
    let fixture = Fixture::new();
    fixture.states(&["exited", "running", "exited", "paused"]);
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    // The second item becomes eligible but was not approved to run in this snapshot.
    // The third was eligible but must not run after its runtime state changed.
    fixture.states(&["exited", "exited", "running", "paused"]);
    let result = fixture
        .core
        .mutate_containers(&id, list.generation, &handles(&list), Action::Start)
        .unwrap();
    assert_eq!(
        outcomes(&result),
        ["succeeded", "skipped", "skipped", "skipped"]
    );
    assert!(result.items[1].error.is_none());
    assert_eq!(result.items[2].error.as_ref().unwrap().code, "StateChanged");
    assert!(result.items[1..].iter().all(|item| item.result.is_none()));
    assert_eq!(fixture.mutations(), 1);
    assert!(!result.mutation_blocked);
}

#[test]
fn daemon_failure_preserves_partial_results_and_continues() {
    let fixture = Fixture::new();
    fixture.states(&["exited", "exited", "exited"]);
    fixture.behaviors(&[(2, "daemon_error")]);
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    let result = fixture
        .core
        .mutate_containers(&id, list.generation, &handles(&list), Action::Start)
        .unwrap();
    assert_eq!(outcomes(&result), ["succeeded", "failed", "succeeded"]);
    assert_eq!(fixture.mutations(), 3);
    let failed = result.items[1].result.as_ref().unwrap();
    assert_eq!(failed.exit_code, Some(1));
    assert_eq!(failed.reconciliation, "succeeded");
    assert_eq!(failed.observed_state.as_deref(), Some("exited"));
    assert!(!result.mutation_blocked);
}

#[test]
fn unknown_result_stops_remaining_work_without_retry_or_losing_results() {
    for mode in ["timeout", "transport_error"] {
        let fixture = Fixture::new();
        fixture.states(&["exited", "exited", "exited", "paused"]);
        fixture.behaviors(&[(2, mode)]);
        let id = fixture.connect();
        let list = fixture.core.list_containers(&id).unwrap();
        let result = fixture
            .core
            .mutate_containers(&id, list.generation, &handles(&list), Action::Start)
            .unwrap();
        assert_eq!(
            outcomes(&result),
            ["succeeded", "resultUnknown", "notExecuted", "skipped"]
        );
        assert_eq!(fixture.mutations(), 2);
        let unknown = result.items[1].result.as_ref().unwrap();
        assert_eq!(unknown.observed_state.as_deref(), Some("running"));
        assert_eq!(unknown.reconciliation, "succeeded");
        assert!(result.items[2].result.is_none());
        assert!(!result.mutation_blocked);
        assert!(!fixture.core.state.lock().unwrap().mutating);
        assert_eq!(
            fixture
                .core
                .mutate_containers(&id, list.generation, &handles(&list), Action::Start)
                .unwrap_err()
                .code,
            "NeedsValidation"
        );
        fixture.core.list_containers(&id).unwrap();
        assert!(!fixture.core.active(&id).unwrap().needs_validation);
    }
}

#[test]
fn reconciliation_or_identity_failure_preserves_results_and_requires_reconnect() {
    for mode in ["reconcile_fail", "change_engine"] {
        let fixture = Fixture::new();
        fixture.states(&["exited", "exited", "exited"]);
        fixture.behaviors(&[(2, mode)]);
        let id = fixture.connect();
        let list = fixture.core.list_containers(&id).unwrap();
        let result = fixture
            .core
            .mutate_containers(&id, list.generation, &handles(&list), Action::Start)
            .unwrap();
        assert_eq!(result.items[0].outcome, "succeeded");
        assert!(result.items[1].result.as_ref().unwrap().mutation_blocked);
        assert_eq!(result.items[2].outcome, "notExecuted");
        assert_eq!(fixture.mutations(), 2);
        assert!(result.mutation_blocked);
        assert!(!fixture.core.state.lock().unwrap().mutating);
        fixture.mode("");
        let next = fixture.core.list_containers(&id).unwrap();
        assert_eq!(
            fixture
                .core
                .mutate_containers(&id, next.generation, &handles(&next), Action::Stop)
                .unwrap_err()
                .code,
            "NeedsValidation"
        );
        let new_id = fixture.connect();
        assert!(!fixture.core.active(&new_id).unwrap().needs_validation);
    }
}

#[test]
fn predispatch_validation_failure_is_an_item_result_with_no_mutation() {
    let fixture = Fixture::new();
    fixture.states(&["exited", "exited"]);
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    fixture.mode("engine_changed");
    let result = fixture
        .core
        .mutate_containers(&id, list.generation, &handles(&list), Action::Start)
        .unwrap();
    assert_eq!(outcomes(&result), ["notExecuted", "notExecuted"]);
    assert_eq!(
        result.items[0].error.as_ref().unwrap().code,
        "EnvironmentChanged"
    );
    assert!(result.items[1].error.is_none());
    assert!(result.mutation_blocked);
    assert_eq!(fixture.mutations(), 0);
    assert!(!fixture.core.state.lock().unwrap().mutating);
}

#[test]
fn single_and_bulk_share_one_global_reservation() {
    for bulk in [false, true] {
        let fixture = Fixture::new();
        fixture.states(&["exited", "exited"]);
        fixture.behaviors(&[(1, "held_mutation")]);
        let id = fixture.connect();
        let list = fixture.core.list_containers(&id).unwrap();
        let core = fixture.core.clone();
        let task_id = id.clone();
        let handle = list.containers[0].handle.clone();
        let generation = list.generation;
        let child = thread::spawn(move || {
            if bulk {
                core.mutate_containers(&task_id, generation, &[handle], Action::Start)
                    .unwrap();
            } else {
                core.mutate_container(&task_id, &handle, Action::Start)
                    .unwrap();
            }
        });
        let started = Instant::now();
        while !fixture.dir.join("mutated").exists() {
            assert!(started.elapsed() < Duration::from_secs(10));
            thread::sleep(Duration::from_millis(5));
        }
        let other = &list.containers[1].handle;
        let trace = fixture.trace();
        assert_eq!(
            fixture
                .core
                .mutate_container(&id, other, Action::Start)
                .unwrap_err()
                .code,
            "Busy"
        );
        assert_eq!(
            fixture
                .core
                .mutate_containers(&id, generation, &[other.clone()], Action::Start)
                .unwrap_err()
                .code,
            "Busy"
        );
        assert_eq!(fixture.core.get_environment().unwrap_err().code, "Busy");
        assert_eq!(fixture.core.list_containers(&id).unwrap_err().code, "Busy");
        assert_eq!(fixture.trace(), trace);
        fs::write(fixture.dir.join("release-mutation"), "1").unwrap();
        child.join().unwrap();
        assert!(!fixture.core.state.lock().unwrap().mutating);
        assert_eq!(fixture.mutations(), 1);
    }
}

#[test]
fn reservation_is_released_and_session_blocked_when_worker_unwinds() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    fixture.core.list_containers(&id).unwrap();
    fixture.core.state.lock().unwrap().mutating = true;
    let state = fixture.core.state.clone();
    let result = std::panic::catch_unwind(move || {
        let _reservation = MutationGuard {
            state,
            session_id: id,
            needs_validation: true,
        };
        panic!("simulate a worker panic after reservation");
    });
    assert!(result.is_err());
    let state = fixture.core.state.lock().unwrap();
    assert!(!state.mutating);
    assert!(state.session.as_ref().unwrap().stale);
    assert!(state.session.as_ref().unwrap().needs_validation);
}

#[test]
fn shutdown_releases_bulk_reservation_and_stops_remaining_dispatch() {
    let fixture = Fixture::new();
    fixture.states(&["exited", "exited"]);
    fixture.behaviors(&[(1, "held_mutation")]);
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    let core = fixture.core.clone();
    let child = thread::spawn(move || {
        core.mutate_containers(&id, list.generation, &handles(&list), Action::Start)
            .unwrap()
    });
    let started = Instant::now();
    while !fixture.dir.join("mutated").exists() {
        assert!(started.elapsed() < Duration::from_secs(10));
        thread::sleep(Duration::from_millis(5));
    }
    fixture.core.shutdown();
    let result = child.join().unwrap();
    assert_eq!(outcomes(&result), ["resultUnknown", "notExecuted"]);
    assert!(result.mutation_blocked);
    assert!(!fixture.core.state.lock().unwrap().mutating);
    assert_eq!(fixture.mutations(), 1);
}

/// Creates three uniquely labeled fixtures and cleans up only verified owned IDs.
#[test]
#[ignore = "Requires prepared local Colima and DOCKER2U_REAL_BULK_SMOKE=1"]
fn real_bulk_runtime_smoke() {
    assert_eq!(
        std::env::var("DOCKER2U_REAL_BULK_SMOKE").as_deref(),
        Ok("1")
    );
    let core = Core::default();
    let environment = core.get_environment().unwrap();
    assert_eq!(environment.status, "ready", "{environment:?}");
    assert!(environment.mutation_allowed);
    let session = core
        .active(environment.session_id.as_deref().unwrap())
        .unwrap();
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let label = format!("io.github.jgoneit.docker2u.bulk-smoke={nonce}");
    struct OwnedContainers {
        core: Core,
        target: Target,
        nonce: String,
        ids: Vec<String>,
        attempted_names: Vec<String>,
        cleaned: bool,
    }
    impl OwnedContainers {
        fn recover_created_ids(&mut self) -> Result<()> {
            if self.attempted_names.is_empty() {
                return Ok(());
            }
            // Create may reach the Engine even if its CLI response is lost. Recover
            // only this run's exact label AND a name recorded before that attempt.
            self.core.verify(&self.target)?;
            let filter = format!("label=io.github.jgoneit.docker2u.bulk-smoke={}", self.nonce);
            let output = self.core.docker(
                &self.target,
                &[
                    "container",
                    "ls",
                    "--all",
                    "--quiet",
                    "--no-trunc",
                    "--filter",
                    &filter,
                ],
                15,
            )?;
            let mut recovered = Vec::new();
            for id in String::from_utf8_lossy(&output).lines().map(str::trim) {
                if !valid_id(id) {
                    return Err(ApiError::new(
                        "FixtureOwnership",
                        "Invalid recovered fixture ID",
                    ));
                }
                recovered.push(id.to_owned());
            }
            if recovered.is_empty() {
                return Ok(());
            }
            for container in self.core.inspect(&self.target, &recovered)? {
                if self.attempted_names.contains(&container.name)
                    && !self.ids.contains(&container.full_id)
                {
                    self.ids.push(container.full_id);
                }
            }
            Ok(())
        }
        fn remove(&self, id: &str) -> Result<()> {
            let label = self.core.docker(
                &self.target,
                &[
                    "container",
                    "inspect",
                    "--format",
                    r#"{{index .Config.Labels "io.github.jgoneit.docker2u.bulk-smoke"}}"#,
                    id,
                ],
                15,
            )?;
            if String::from_utf8_lossy(&label).trim() != self.nonce {
                return Err(ApiError::new(
                    "FixtureOwnership",
                    format!("Refusing cleanup of unverified fixture {id}"),
                ));
            }
            self.core
                .docker(&self.target, &["container", "rm", "--force", id], 30)?;
            Ok(())
        }
        fn cleanup(&mut self) -> Result<()> {
            for id in &self.ids {
                self.remove(id)?;
            }
            self.cleaned = true;
            Ok(())
        }
    }
    impl Drop for OwnedContainers {
        fn drop(&mut self) {
            if !self.cleaned {
                if let Err(error) = self.recover_created_ids() {
                    eprintln!("owned bulk smoke recovery unresolved: {error:?}");
                }
                for id in &self.ids {
                    if let Err(error) = self.remove(id) {
                        eprintln!("owned bulk smoke fallback cleanup {id}: {error:?}");
                    }
                }
            }
        }
    }
    let mut owned = OwnedContainers {
        core: core.clone(),
        target: session.target.clone(),
        nonce,
        ids: vec![],
        attempted_names: vec![],
        cleaned: false,
    };
    core.docker(&session.target, &["image", "pull", "busybox:1.37.0"], 120)
        .unwrap();
    for index in 0..3 {
        let name = format!("docker2u-bulk-smoke-{}-{index}", &owned.nonce[..12]);
        owned.attempted_names.push(name.clone());
        let output = core
            .docker(
                &session.target,
                &[
                    "container",
                    "create",
                    "--name",
                    &name,
                    "--label",
                    &label,
                    "--stop-timeout",
                    "1",
                    "busybox:1.37.0",
                    "sh",
                    "-c",
                    "while :; do sleep 1; done",
                ],
                30,
            )
            .unwrap();
        let id = String::from_utf8(output).unwrap().trim().to_owned();
        assert!(valid_id(&id));
        owned.ids.push(id);
    }
    let select = |mut list: ContainerList| {
        list.containers
            .retain(|container| owned.ids.contains(&container.full_id));
        assert_eq!(list.containers.len(), 3);
        list
    };
    let initial = select(core.list_containers(&session.id).unwrap());
    core.mutate_container(&session.id, &initial.containers[0].handle, Action::Start)
        .unwrap();
    let mut list = select(core.list_containers(&session.id).unwrap());
    assert_eq!(list.containers[0].state, "running");
    for (action, expected_outcomes, expected_state) in [
        (
            Action::Start,
            ["skipped", "succeeded", "succeeded"],
            "running",
        ),
        (
            Action::Restart,
            ["succeeded", "succeeded", "succeeded"],
            "running",
        ),
        (
            Action::Stop,
            ["succeeded", "succeeded", "succeeded"],
            "exited",
        ),
        (
            Action::Start,
            ["succeeded", "succeeded", "succeeded"],
            "running",
        ),
    ] {
        let result = core
            .mutate_containers(&session.id, list.generation, &handles(&list), action)
            .unwrap();
        assert_eq!(outcomes(&result), expected_outcomes, "{result:?}");
        assert!(!result.mutation_blocked);
        for item in &result.items {
            if let Some(result) = &item.result {
                assert_eq!(result.reconciliation, "succeeded");
                assert_eq!(result.observed_state.as_deref(), Some(expected_state));
            }
        }
        let next = select(core.list_containers(&session.id).unwrap());
        assert!(next.generation > list.generation);
        assert!(
            next.containers
                .iter()
                .all(|container| container.state == expected_state)
        );
        eprintln!(
            "real bulk {}: {:?}; refreshed generation {}",
            action.name(),
            outcomes(&result),
            next.generation
        );
        list = next;
    }
    let ids = owned.ids.clone();
    owned
        .cleanup()
        .expect("Exact owned bulk fixture cleanup failed");
    // A connection error is not evidence of deletion: require a successful full list.
    let remaining = core.list_containers(&session.id).unwrap();
    for id in ids {
        assert!(
            remaining
                .containers
                .iter()
                .all(|container| container.full_id != id),
            "Owned bulk fixture remains: {id}"
        );
    }
}
