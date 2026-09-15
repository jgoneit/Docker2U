use super::*;
use std::collections::BTreeMap;

fn checked<T>(result: Result<T>, operation: &str) -> T {
    result.unwrap_or_else(|error| panic!("{operation} failed: {}", error.code))
}

/// Opt-in, read-only evidence against the current Docker CLI context. The probe
/// requires an existing running Compose project. Existing log output is optional:
/// a healthy quiet stream is valid, while emitted rows provide extra evidence.
/// It never
/// creates, starts, stops, restarts, executes in, or removes any container.
#[test]
#[ignore = "Requires DOCKER2U_REAL_OBSERVATION_READ_ONLY=1 and an existing running Compose project"]
fn real_engine_observation_read_only() {
    assert_eq!(
        std::env::var("DOCKER2U_REAL_OBSERVATION_READ_ONLY").as_deref(),
        Ok("1")
    );
    let core = Core::default();
    struct Shutdown(Core);
    impl Drop for Shutdown {
        fn drop(&mut self) {
            self.0.shutdown();
        }
    }
    let _shutdown = Shutdown(core.clone());
    let environment = checked(core.get_environment(), "connect current context");
    assert_eq!(
        environment.status, "ready",
        "A supported local Engine is required"
    );
    let id = environment
        .session_id
        .as_deref()
        .expect("Session identity missing");
    let initial_session = checked(core.active(id), "read pinned session");
    let server: Value = serde_json::from_slice(&checked(
        core.docker(
            &initial_session.target,
            &["version", "--format", "{{json .Server}}"],
            10,
        ),
        "read pinned Engine version",
    ))
    .expect("Engine version JSON malformed");
    let version = required(&server, "Version").expect("Engine version missing");
    let minimum = required(&server, "MinAPIVersion").expect("Engine minimum API missing");
    let maximum = required(&server, "ApiVersion").expect("Engine maximum API missing");
    let api = |value: &str| -> (u32, u32) {
        let (major, minor) = value.split_once('.').expect("Malformed Engine API version");
        (
            major.parse().expect("Malformed API major"),
            minor.parse().expect("Malformed API minor"),
        )
    };
    let negotiated = api(maximum).min((1, 47));
    assert!(
        negotiated >= api(minimum).max((1, 40)),
        "No supported read-only observation API overlap"
    );
    assert_eq!(version, initial_session.target.fingerprint.server);
    assert_eq!(maximum, initial_session.target.fingerprint.api);

    let initial = checked(core.list_containers(id), "list existing containers");
    let mut projects = BTreeMap::<String, Vec<&Container>>::new();
    for container in &initial.containers {
        if container.state == "running" {
            if let Some(project) = &container.compose_project {
                projects.entry(project.clone()).or_default().push(container);
            }
        }
    }
    let (project, running) =
        if let Ok(requested) = std::env::var("DOCKER2U_REAL_OBSERVATION_PROJECT") {
            let rows = projects
                .remove(&requested)
                .expect("Requested project has no running containers");
            (requested, rows)
        } else {
            projects
                .into_iter()
                .max_by_key(|(_, rows)| rows.len())
                .expect("Precondition: an existing running Compose project is required")
        };
    let scope = ObservationScope::Project {
        name: project.clone(),
    };
    let log_handles = running
        .iter()
        .take(64)
        .map(|container| container.handle.clone())
        .collect::<Vec<_>>();
    // Configure sources before the scheduler regenerates opaque inventory handles.
    let started = checked(
        core.configure_project_logs(id, &project, Some(log_handles)),
        "start read-only project logs",
    );
    checked(
        core.configure_observation(id, scope.clone()),
        "start background observations",
    );
    let query = ProjectLogQuery {
        project,
        source_ids: vec![],
        keyword: String::new(),
        offset: None,
        limit: 500,
        after_sequence: None,
        through_sequence: None,
        anchor_row_id: None,
        time_from: None,
        time_to: None,
        anchor_time: None,
    };
    let started_at = Instant::now();
    let deadline = started_at + Duration::from_secs(20);
    let mut log_rows = started.rows.len();
    let mut following_sources = 0;
    let mut resource_points = 0;
    let mut distinct_samples = 0;
    let mut events = 0;
    let mut event_following = false;
    let mut inventory_generation = initial.generation;
    let mut log_errors = 0;
    let mut log_error_codes = BTreeMap::<String, usize>::new();
    while Instant::now() < deadline {
        let observed = checked(core.read_observation(id, 0), "read background history");
        assert_eq!(observed.session_id, id);
        assert_eq!(observed.scope, scope);
        if let Some(error) = observed.inventory_error {
            panic!("Inventory observation failed: {}", error.code);
        }
        if let Some(error) = observed.stats_error {
            panic!("Resource observation failed: {}", error.code);
        }
        if let Some(error) = observed.event_error {
            panic!("Event observation failed: {}", error.code);
        }
        let inventory = observed.inventory.expect("Background inventory missing");
        assert!(!inventory.stale, "Background inventory became stale");
        inventory_generation = inventory.generation;
        resource_points = observed
            .resources
            .iter()
            .filter(|point| point.available)
            .count();
        distinct_samples = observed
            .resources
            .iter()
            .filter(|point| point.available)
            .map(|point| &point.sampled_at)
            .collect::<HashSet<_>>()
            .len();
        for point in observed.resources.iter().filter(|point| point.available) {
            assert!(
                point
                    .cpu_percent
                    .is_some_and(|value| value.is_finite() && value >= 0.0)
            );
            assert!(
                point
                    .memory_usage_bytes
                    .is_some_and(|value| value.is_finite() && value >= 0.0)
            );
        }
        events = observed.events.len();
        event_following = observed.event_status == "following";
        let logs = checked(
            core.query_project_logs(id, &query),
            "read bounded project log page",
        );
        assert_eq!(logs.session_id, id);
        log_rows = log_rows.max(logs.rows.len());
        following_sources = logs
            .sources
            .iter()
            .filter(|source| source.selected && source.status == "following")
            .count();
        log_errors = logs
            .sources
            .iter()
            .filter(|source| source.error.is_some())
            .count();
        log_error_codes.clear();
        for error in logs
            .sources
            .iter()
            .filter_map(|source| source.error.as_ref())
        {
            *log_error_codes.entry(error.code.clone()).or_default() += 1;
        }
        assert!(logs.rows.iter().all(|row| {
            valid_id(&row.full_id)
                && row
                    .timestamp
                    .as_ref()
                    .is_none_or(|value| chrono::DateTime::parse_from_rfc3339(value).is_ok())
        }));
        if event_following
            && following_sources > 0
            && distinct_samples >= 2
            && inventory_generation >= initial.generation + 2
        {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    // Corroborate the latest tail through the existing, pinned CLI path.
    // Use log capture mode: checked_output captures stdout/stderr separately
    // and leaves Output.logs empty. Report only the bounded combined count.
    let mut cli_tail_log_lines = 0;
    for container in running.iter().take(64) {
        let target = &initial_session.target;
        let output = checked(
            core.runner
                .run(
                    &target.docker,
                    &target.engine_args(&["logs", "--tail", "300", &container.full_id]),
                    &target.env,
                    Duration::from_secs(10),
                    true,
                )
                .map_err(|_| ApiError::new("StartFailed", "CLI log count could not start")),
            "count latest logs using pinned CLI",
        );
        assert!(
            output.code == Some(0) && !output.interrupted,
            "CLI log count failed or was interrupted"
        );
        cli_tail_log_lines += String::from_utf8_lossy(&output.logs).lines().count();
    }
    if cli_tail_log_lines > 0 {
        let latest = checked(
            core.query_project_logs(id, &query),
            "confirm existing Docker output is retained",
        );
        log_rows = log_rows.max(latest.rows.len());
    }
    // Exercise incident queries against already retained data without replaying
    // or reconfiguring any source. A quiet project proves the empty-query path;
    // only a nonempty result supplies evidence of actual historical row reads.
    let retained = checked(
        core.query_project_logs(id, &query),
        "read incident source snapshot",
    );
    let row = retained.rows.get(retained.rows.len() / 2);
    let incident_id = row.map_or_else(|| running[0].full_id.clone(), |row| row.full_id.clone());
    let incident_time = row
        .map(|row| row.timestamp.as_ref().unwrap_or(&row.received_at).clone())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let anchor = chrono::DateTime::parse_from_rfc3339(&incident_time).unwrap();
    let from = anchor - chrono::Duration::minutes(2);
    let to = anchor + chrono::Duration::minutes(2);
    let mut incident_query = query.clone();
    incident_query.source_ids = vec![incident_id.clone()];
    incident_query.through_sequence = Some(retained.max_sequence);
    incident_query.time_from = Some(from.to_rfc3339());
    incident_query.time_to = Some(to.to_rfc3339());
    incident_query.anchor_time = Some(incident_time);
    let incident = checked(
        core.query_project_logs(id, &incident_query),
        "read retained incident interval",
    );
    assert_eq!(incident.session_id, id);
    assert_eq!(incident.project, query.project);
    assert!(incident.rows.len() <= 500);
    if row.is_some() {
        assert!(
            !incident.rows.is_empty(),
            "Retained interval unexpectedly lost its anchor data"
        );
    }
    assert!(incident.rows.iter().all(|row| {
        let time = chrono::DateTime::parse_from_rfc3339(
            row.timestamp.as_ref().unwrap_or(&row.received_at),
        )
        .unwrap();
        row.full_id == incident_id
            && time >= from
            && time <= to
            && row.sequence <= retained.max_sequence
    }));
    // Report metadata only, including on assertion failure. Never print rows,
    // service/project/container names, command output, or Engine credentials.
    eprintln!(
        "read-only observation: context={} server={} api_min={} api_max={} negotiated={}.{} inventory={} running_project={} following_sources={} source_errors={} retained_log_rows={} resource_points={} sample_times={} events={} event_following={} inventory_refreshes={} observe_seconds={:.1}",
        environment.context_name.as_deref().unwrap_or("unknown"),
        version,
        minimum,
        maximum,
        negotiated.0,
        negotiated.1,
        initial.containers.len(),
        running.len(),
        following_sources,
        log_errors,
        log_rows,
        resource_points,
        distinct_samples,
        events,
        event_following,
        inventory_generation.saturating_sub(initial.generation),
        started_at.elapsed().as_secs_f64()
    );
    eprintln!("read-only log source error codes: {log_error_codes:?}");
    eprintln!(
        "read-only incident query: rows={} source_snapshot_has_rows={}",
        incident.rows.len(),
        row.is_some()
    );
    eprintln!(
        "read-only log body evidence: api_has_rows={} cli_latest_tail_lines={cli_tail_log_lines}",
        log_rows > 0
    );
    assert!(
        cli_tail_log_lines == 0 || log_rows > 0,
        "Docker has existing output but the project log page is empty"
    );
    assert!(
        event_following,
        "Engine event subscription did not reach Following"
    );
    assert!(
        following_sources > 0,
        "No existing project log source reached Following"
    );
    assert!(
        distinct_samples >= 2,
        "Expected at least two resource history samples"
    );
    assert!(
        inventory_generation >= initial.generation + 2,
        "Expected background inventory refresh after the initial publication"
    );
    checked(
        core.verify(&initial_session.target),
        "verify pinned Engine after observation",
    );
    let final_session = checked(core.active(id), "read final pinned session");
    assert_eq!(
        final_session.target.fingerprint,
        initial_session.target.fingerprint
    );
    assert_eq!(
        final_session.target.endpoint,
        initial_session.target.endpoint
    );
    assert!(!final_session.needs_validation);
}
