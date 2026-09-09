use super::*;

fn session() -> Session {
    Session {
        id: "session".into(),
        generation: 7,
        stale: false,
        needs_validation: false,
        handles: HashMap::new(),
        target: Target {
            docker: "/fixture/docker".into(),
            client_version: "fixture".into(),
            endpoint: "unix:///fixture/engine.sock".into(),
            env: vec![],
            docker_config: "/fixture/config".into(),
            fingerprint: Fingerprint {
                id: "engine".into(),
                server: "1".into(),
                api: "1.54".into(),
                os: "linux".into(),
                arch: "arm64".into(),
                name: "fixture".into(),
            },
        },
    }
}
fn base() -> Value {
    serde_json::json!({"Id":"a".repeat(64), "State":"running"})
}
fn parse(value: &Value) -> ContainerDetails {
    parse_details(
        &serde_json::to_vec(value).unwrap(),
        &session(),
        "opaque",
        &"a".repeat(64),
    )
    .unwrap()
}

#[test]
fn details_contract_is_identity_bound_and_projects_only_known_fields() {
    let mut data = base();
    data["Config"] = serde_json::json!({"Env":["secret=private"]});
    data["ExitCode"] = serde_json::json!(137);
    data["OOMKilled"] = serde_json::json!(true);
    data["FinishedAt"] = serde_json::json!("2026-09-08T03:04:05.123456789Z");
    let result = serde_json::to_value(parse(&data)).unwrap();
    assert_eq!(result["sessionId"], "session");
    assert_eq!(result["generation"], 7);
    assert_eq!(result["handle"], "opaque");
    assert_eq!(result["fullId"], "a".repeat(64));
    assert_eq!(result["diagnostics"]["exitCode"], 137);
    assert_eq!(result["diagnostics"]["oomKilled"], true);
    assert_eq!(
        result["diagnostics"]["finishedAt"],
        "2026-09-08T03:04:05.123456789Z"
    );
    assert!(chrono::DateTime::parse_from_rfc3339(result["observedAt"].as_str().unwrap()).is_ok());
    assert!(!result.to_string().contains("secret"));
    for forbidden in [
        "{{json .}}",
        "Config.Env",
        "Config.Labels",
        "HostConfig}}",
        "NetworkSettings}}",
        "json .Config",
        "json $config",
        "json $health",
        "json $test",
        "index $test 1",
    ] {
        assert!(!DETAILS_FORMAT.contains(forbidden));
    }
}

#[test]
fn health_configuration_is_distinct_from_runtime_observation_and_unknown_fields() {
    let mut data = base();
    data["State"] = serde_json::json!("created");
    data["Health"] = Value::Null;
    assert!(parse(&data).diagnostics.health_configured.is_none());
    for (value, expected) in [
        (serde_json::json!(true), Some(true)),
        (serde_json::json!(false), Some(false)),
        (Value::Null, None),
        (serde_json::json!("false"), None),
    ] {
        data["HealthConfigured"] = value;
        let diagnostics = parse(&data).diagnostics;
        assert_eq!(diagnostics.health_configured, expected);
        assert!(diagnostics.health_available && diagnostics.health.is_none());
    }
}

#[test]
fn mismatched_missing_duplicate_or_malformed_identity_is_rejected() {
    let mut wrong = base();
    wrong["Id"] = serde_json::json!("b".repeat(64));
    let valid = serde_json::to_string(&base()).unwrap();
    for bytes in [
        wrong.to_string(),
        "".into(),
        "{".into(),
        format!("{valid}\n{valid}"),
        "{\"Id\":null,\"State\":\"running\"}".into(),
    ] {
        assert_eq!(
            parse_details(bytes.as_bytes(), &session(), "opaque", &"a".repeat(64))
                .unwrap_err()
                .code,
            "MalformedOutput"
        );
    }
}

#[test]
fn incomplete_health_history_is_unavailable_and_unrepresentable_numbers_stay_unknown() {
    let mut data = base();
    data["Health"] = serde_json::json!({"Status":"healthy"});
    data["RestartCount"] = serde_json::json!(9_007_199_254_740_992_u64);
    data["ExitCode"] = serde_json::json!(i64::MAX);
    let details = parse(&data);
    assert!(!details.diagnostics.health_available);
    assert!(details.diagnostics.restart_count.is_none() && details.diagnostics.exit_code.is_none());
    data["Health"]["Log"] = Value::Null;
    assert!(parse(&data).diagnostics.health_available);
    data["Health"]["Log"] = serde_json::json!([{"ExitCode":1}]);
    assert!(!parse(&data).diagnostics.health_available);
}

#[test]
fn absent_optional_details_are_unknown_while_null_collections_are_known_empty() {
    let mut data = base();
    let details = parse(&data);
    let facts = details.diagnostics;
    assert!(
        facts.exit_code.is_none() && facts.oom_killed.is_none() && facts.restart_count.is_none()
    );
    assert!(facts.started_at.is_none() && facts.finished_at.is_none());
    assert!(!facts.health_available);
    assert!(!details.connectivity.ports_available && !details.connectivity.networks_available);
    data["Health"] = Value::Null;
    data["Ports"] = Value::Null;
    data["Networks"] = Value::Null;
    data["ExitCode"] = serde_json::json!(0);
    data["RestartCount"] = serde_json::json!(0);
    data["OOMKilled"] = serde_json::json!(false);
    data["FinishedAt"] = serde_json::json!("0001-01-01T00:00:00Z");
    data["StartedAt"] = serde_json::json!("invalid");
    let details = parse(&data);
    assert_eq!(details.diagnostics.exit_code, Some(0));
    assert_eq!(details.diagnostics.oom_killed, Some(false));
    assert_eq!(details.diagnostics.restart_count, Some(0));
    assert!(details.diagnostics.finished_at.is_none() && details.diagnostics.started_at.is_none());
    assert!(details.diagnostics.health_available);
    assert!(details.connectivity.ports_available && details.connectivity.networks_available);
}

#[test]
fn health_returns_three_latest_failed_checks_with_plain_bounded_utf8_output() {
    let mut data = base();
    let mut log = Vec::new();
    for code in [1, 2, 0, 3, 4] {
        log.push(serde_json::json!({"Start":"2026-09-08T01:00:00Z","End":"2026-09-08T01:00:01Z","ExitCode":code,"Output":format!("{}\u{1b}[31mred\u{1b}[0m\0", "한글".repeat(2000))}));
    }
    data["Health"] = serde_json::json!({"Status":"unhealthy","FailingStreak":2,"Log":log});
    let details = parse(&data);
    let health = details.diagnostics.health.unwrap();
    assert_eq!(health.status.as_deref(), Some("unhealthy"));
    assert_eq!(health.failing_streak, Some(2));
    assert_eq!(
        health
            .recent_failures
            .iter()
            .map(|entry| entry.exit_code)
            .collect::<Vec<_>>(),
        vec![4, 3, 2]
    );
    for failure in health.recent_failures {
        assert!(failure.output.len() <= 4096 && failure.truncated);
        assert!(failure.output.ends_with("red"));
        assert!(!failure.output.contains(['\u{1b}', '\0']));
    }
}

#[test]
fn ports_preserve_ipv4_ipv6_wildcards_protocols_and_unpublished_exposure() {
    let mut data = base();
    data["Ports"] = serde_json::json!({
        "8080/tcp":[{"HostIp":"0.0.0.0","HostPort":"18080"},{"HostIp":"::","HostPort":"18080"},{"HostIp":"192.168.1.2","HostPort":"18081"}],
        "8080/udp":[{"HostIp":"::1","HostPort":"18080"}],
        "5432/tcp":null,
        "9090/tcp":[{"HostIp":"127.0.0.1","HostPort":""}]
    });
    let details = parse(&data);
    assert!(details.connectivity.ports_available);
    let ports = details.connectivity.ports;
    assert_eq!(ports.len(), 4);
    assert_eq!(ports[0].container_port, 5432);
    assert!(ports[0].bindings.is_empty());
    assert_eq!(ports[1].protocol, "tcp");
    assert_eq!(
        ports[1]
            .bindings
            .iter()
            .map(|binding| binding.host_ip.as_str())
            .collect::<Vec<_>>(),
        vec!["0.0.0.0", "192.168.1.2", "::"]
    );
    assert_eq!(ports[2].protocol, "udp");
    assert_eq!(ports[2].bindings[0].host_ip, "::1");
    assert_eq!(ports[3].bindings[0].host_port, None);
}

#[test]
fn networks_keep_scoped_aliases_and_mode_without_inventing_host_routes() {
    for mode in ["host", "none", "bridge", "container:another-container"] {
        let mut data = base();
        data["NetworkMode"] = serde_json::json!(mode);
        data["Networks"] = serde_json::json!({
            "z-network":{"Aliases":null,"IPAddress":"","GlobalIPv6Address":""},
            "a-network":{"Aliases":["api", "api", "backend"],"IPAddress":"172.18.0.2","GlobalIPv6Address":"fd00::2"}
        });
        let details = parse(&data);
        assert_eq!(details.connectivity.network_mode.as_deref(), Some(mode));
        assert!(details.connectivity.networks_available);
        let networks = details.connectivity.networks;
        assert_eq!(networks[0].name, "a-network");
        assert_eq!(networks[0].aliases, vec!["api", "backend"]);
        assert_eq!(networks[0].ipv4_address.as_deref(), Some("172.18.0.2"));
        assert_eq!(networks[0].ipv6_address.as_deref(), Some("fd00::2"));
        assert!(networks[1].aliases.is_empty() && networks[1].ipv4_address.is_none());
    }
}

#[test]
fn malformed_optional_details_do_not_become_normal_or_empty_facts() {
    let mut data = base();
    data["ExitCode"] = serde_json::json!("0");
    data["RestartCount"] = serde_json::json!(-1);
    data["OOMKilled"] = serde_json::json!("false");
    data["Health"] = serde_json::json!("healthy");
    data["Ports"] = serde_json::json!({"80/tcp":[{"HostIp":"https://bad","HostPort":"80"}]});
    data["Networks"] = serde_json::json!({"network":{"Aliases":[1]}});
    let details = parse(&data);
    assert!(
        details.diagnostics.exit_code.is_none()
            && details.diagnostics.restart_count.is_none()
            && details.diagnostics.oom_killed.is_none()
    );
    assert!(!details.diagnostics.health_available);
    assert!(!details.connectivity.ports_available && details.connectivity.ports.is_empty());
    assert!(!details.connectivity.networks_available && details.connectivity.networks.is_empty());
}
