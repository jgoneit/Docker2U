use super::*;

/// Opt-in integration evidence against the current pinned Engine. Only the exact
/// container created here can be started, restarted, or removed by this test.
#[test]
#[ignore = "Requires a local Engine and DOCKER2U_REAL_INSIGHTS_SMOKE=1"]
fn real_live_insights_smoke() {
    assert_eq!(
        std::env::var("DOCKER2U_REAL_INSIGHTS_SMOKE").as_deref(),
        Ok("1")
    );
    let core = Core::default();
    let environment = core.get_environment().unwrap();
    assert_eq!(environment.status, "ready", "{environment:?}");
    let session = core
        .active(environment.session_id.as_deref().unwrap())
        .unwrap();
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let name = format!("docker2u-insights-{}", &nonce[..12]);
    let label = format!("io.github.jgoneit.docker2u.insights-smoke={nonce}");
    let project_label = format!("com.docker.compose.project={name}");
    let image = "busybox:1.37.0";
    if core
        .docker(
            &session.target,
            &["image", "inspect", "--format", "{{.Id}}", image],
            15,
        )
        .is_err()
    {
        core.docker(&session.target, &["image", "pull", image], 120)
            .unwrap();
    }
    let created = core.docker(&session.target, &[
        "container", "create", "--name", &name, "--label", &label,
        "--label", &project_label, "--label", "com.docker.compose.service=api",
        "--network", "none", "--memory", "64m", "--cpus", "0.25", "--stop-timeout", "1",
        image, "sh", "-c",
        "boot=$(cat /proc/sys/kernel/random/uuid); echo boot:$boot; echo stderr-boot:$boot >&2; i=0; while :; do echo tick:$boot:$i; i=$((i+1)); sleep 0.2; done",
    ], 30).unwrap();
    let full_id = String::from_utf8(created).unwrap().trim().to_owned();
    assert!(valid_id(&full_id));

    struct OwnedContainer {
        core: Core,
        target: Target,
        full_id: String,
        name: String,
        nonce: String,
        removed: bool,
    }
    impl OwnedContainer {
        fn remove(&mut self) -> Result<()> {
            if self.removed {
                return Ok(());
            }
            self.core.cancel_log_stream();
            self.core.verify(&self.target)?;
            let proof: Value = serde_json::from_slice(&self.core.docker(&self.target, &[
                "container", "inspect", "--format",
                r#"{"Id":{{json .Id}},"Name":{{json .Name}},"Owner":{{json (index .Config.Labels "io.github.jgoneit.docker2u.insights-smoke")}}}"#,
                &self.full_id,
            ], 15)?).map_err(|error| malformed(error.to_string()))?;
            if proof["Id"].as_str() != Some(self.full_id.as_str())
                || proof["Name"].as_str() != Some(format!("/{}", self.name).as_str())
                || proof["Owner"].as_str() != Some(self.nonce.as_str())
            {
                return Err(ApiError::new(
                    "InvalidSelection",
                    "Owned smoke cleanup identity did not match",
                ));
            }
            self.core.docker(
                &self.target,
                &["container", "rm", "--force", &self.full_id],
                30,
            )?;
            self.removed = true;
            eprintln!("insights exact owned cleanup completed: {}", self.full_id);
            Ok(())
        }
    }
    impl Drop for OwnedContainer {
        fn drop(&mut self) {
            if let Err(error) = self.remove() {
                eprintln!(
                    "insights owned cleanup failed for {}: {}",
                    self.full_id, error.message
                );
            }
        }
    }
    let mut owned = OwnedContainer {
        core: core.clone(),
        target: session.target.clone(),
        full_id: full_id.clone(),
        name: name.clone(),
        nonce,
        removed: false,
    };
    let own_row = |list: &ContainerList| {
        list.containers
            .iter()
            .find(|container| container.full_id == full_id)
            .cloned()
            .expect("Owned smoke container is missing")
    };
    let id = &session.id;
    let initial = core.list_containers(id).unwrap();
    let row = own_row(&initial);
    assert_eq!(row.name, name);
    assert_eq!(row.state, "created");
    assert_eq!(row.compose_project.as_deref(), Some(name.as_str()));
    assert_eq!(row.compose_service.as_deref(), Some("api"));
    assert_eq!(
        core.mutate_container(id, &row.handle, Action::Start)
            .unwrap()
            .outcome,
        "succeeded"
    );
    let running = core.list_containers(id).unwrap();
    let row = own_row(&running);
    assert_eq!(row.state, "running");
    let started = core
        .start_log_stream(id, running.generation, &row.handle)
        .unwrap();

    fn drain_until(core: &Core, id: &str, stream_id: &str, done: impl Fn(&str) -> bool) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut text = String::new();
        while Instant::now() < deadline {
            let chunk = core.read_log_stream(id, stream_id).unwrap();
            assert!(chunk.error.is_none(), "stream error: {:?}", chunk.error);
            text.push_str(&chunk.text);
            if done(&text) {
                return text;
            }
            assert!(!chunk.terminal, "stream ended before expected live output");
            thread::sleep(Duration::from_millis(100));
        }
        panic!("Expected owned container log output was not observed within 10 seconds");
    }
    let text = drain_until(&core, id, &started.stream_id, |text| {
        text.contains("stderr-boot:") && text.contains("tick:")
    });
    let boot = text
        .lines()
        .find_map(|line| line.split_once(" boot:").map(|(_, boot)| boot.to_owned()))
        .expect("initial boot marker missing");
    let next = drain_until(&core, id, &started.stream_id, |text| text.contains("tick:"));
    assert!(
        next.contains(&boot),
        "follow must receive output generated after the first drain"
    );
    let cli_logs = String::from_utf8(
        core.docker(
            &session.target,
            &[
                "container",
                "logs",
                "--tail",
                "300",
                "--timestamps",
                &full_id,
            ],
            15,
        )
        .unwrap(),
    )
    .unwrap();
    assert!(cli_logs.contains(&boot));
    assert!(cli_logs.contains("tick:"));

    let refreshed = core.list_containers(id).unwrap();
    let refreshed_row = own_row(&refreshed);
    assert_ne!(refreshed_row.handle, row.handle);
    assert!(
        !core
            .read_log_stream(id, &started.stream_id)
            .unwrap()
            .terminal,
        "ordinary refresh must retain the same full-ID stream"
    );
    let sample = core
        .get_container_stats(id, refreshed.generation, &[refreshed_row.handle.clone()])
        .unwrap();
    assert!(sample.error.is_none(), "{:?}", sample.error);
    let item = &sample.items[0];
    assert!(item.available);
    assert_eq!(item.full_id, full_id);
    let cli_stats = json_lines(
        &core
            .docker(
                &session.target,
                &[
                    "container",
                    "stats",
                    "--no-stream",
                    "--no-trunc",
                    "--format",
                    "{{json .}}",
                    &full_id,
                ],
                15,
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(cli_stats.len(), 1);
    assert_eq!(required(&cli_stats[0], "ID").unwrap(), full_id);
    let cli_cpu: f64 = required(&cli_stats[0], "CPUPerc")
        .unwrap()
        .strip_suffix('%')
        .unwrap()
        .parse()
        .unwrap();
    let cli_memory = required(&cli_stats[0], "MemUsage").unwrap();
    let memory = item.memory_usage.as_deref().unwrap();
    assert_eq!(
        memory.split_once(" / ").unwrap().1,
        cli_memory.split_once(" / ").unwrap().1
    );
    // Sequential samples cannot be equal by definition. This quiet quarter-CPU
    // fixture allows one core's 0.25 quota worth of variation plus sampling jitter.
    assert!(cli_cpu.is_finite() && cli_cpu >= 0.0);
    assert!((item.cpu_percent.unwrap() - cli_cpu).abs() <= 30.0);
    eprintln!(
        "insights live comparison: cpu={}%, cliCpu={}%, memory={}, cliMemory={}",
        item.cpu_percent.unwrap(),
        cli_cpu,
        memory,
        cli_memory
    );

    assert_eq!(
        core.mutate_container(id, &refreshed_row.handle, Action::Restart)
            .unwrap()
            .outcome,
        "succeeded"
    );
    let restarted = core.list_containers(id).unwrap();
    let restarted_row = own_row(&restarted);
    assert_eq!(restarted_row.state, "running");
    assert_eq!(restarted_row.full_id, full_id);
    // Docker may end a follow connection during restart. Explicit resubscription
    // verifies the same full ID after reconciliation without retrying the mutation.
    core.stop_log_stream(id, &started.stream_id).unwrap();
    let resumed = core
        .start_log_stream(id, restarted.generation, &restarted_row.handle)
        .unwrap();
    let after_restart = drain_until(&core, id, &resumed.stream_id, |text| {
        text.lines().any(|line| {
            line.split_once(" boot:")
                .is_some_and(|(_, current)| current != boot)
        })
    });
    assert!(after_restart.contains("boot:"));
    let after_stats = core
        .get_container_stats(id, restarted.generation, &[restarted_row.handle])
        .unwrap();
    assert!(after_stats.error.is_none());
    assert!(after_stats.items[0].available);
    core.stop_log_stream(id, &resumed.stream_id).unwrap();
    owned.remove().unwrap();
    let remaining = core
        .docker(
            &session.target,
            &[
                "container",
                "ls",
                "--all",
                "--quiet",
                "--no-trunc",
                "--filter",
                &format!("label={label}"),
            ],
            15,
        )
        .unwrap();
    assert!(
        remaining.is_empty(),
        "Owned smoke container remained after cleanup"
    );
    core.shutdown();
    eprintln!(
        "insights real runtime: Compose metadata, follow stdout/stderr, subsequent live output, refresh retention, CLI resource comparison, exact-ID restart, resumed logs/stats and verified cleanup passed"
    );
}
