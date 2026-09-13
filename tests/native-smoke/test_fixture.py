import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixture = load("native_smoke_fixture", REPO / "scripts/native-smoke-fixture.py")
docker = load("native_smoke_docker", Path(__file__).with_name("fake_docker.py"))


def identity():
    return {"runId": "test-owned-run", "binarySha256": "a" * 64, "startedAtMs": 1000}


def step(name, timestamp, detail=None):
    return {"name": name, "timeMs": timestamp, "detail": detail or {}}


def clear_report():
    return {"marker": "NATIVE_SMOKE_HARNESS", "binding": identity(), "mode": "worker", "nativeIpc": True,
            "status": "passed", "failures": [], "workerEvents": [], "steps": [
                step("started connection-clear", 1100), step("requested pending logs", 1200),
                step("cleared pending logs", 1500), step("native connection warning preserved after Clear", 4300),
                step("passed connection-clear", 4400)]}


def native_events():
    return [{"phase": "held-info", "pid": 41, "timeMs": 1300},
            {"phase": "engine-change-reply", "pid": 41, "timeMs": 4300}]


class FixtureIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve() / "owned"
        fixture.make_fixture(self.root)
        fixture.write_json(self.root / "launch.json", identity())
        self.environment = fixture.child_environment(self.root)
        self.host = ["--host", "unix://" + str(self.root / "engine.sock")]

    def cli(self, arguments):
        return subprocess.run([sys.executable, str(self.root / "docker"), *arguments], env=self.environment, capture_output=True, timeout=5)

    def test_dense_payload_is_exact_limit_and_launch_bound(self):
        payload = docker.dense_logs(identity())
        self.assertEqual(len(payload), 2 * 1024 * 1024)
        self.assertTrue(payload.endswith(docker.END))
        self.assertEqual(json.loads(payload.splitlines()[0].removeprefix(b"NATIVE_SMOKE_RUN ")), identity())
        result = self.cli(self.host + ["container", "logs", "--tail", "300", "--timestamps", format(1, "064x")])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, payload)
        row = next(row for row in fixture.read_trace(self.root) if row["phase"] == "logs-payload")
        self.assertEqual(row["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(row["aCount"], payload.lower().count(b"a"))

    def test_only_child_environment_and_owned_config_change(self):
        before = dict(os.environ)
        with patch.dict(os.environ, {"DOCKER_HOST": "unix:///real.sock", "DOCKER_CONTEXT": "real", "DOCKER_TLS_VERIFY": "1", "COLIMA_HOME": "/real-colima", "LIMA_HOME": "/real-lima", "COMPOSE_FILE": "/real-compose.yaml", "BUILDX_BUILDER": "remote", "BUILDKIT_HOST": "tcp://real:1234"}):
            actual = fixture.child_environment(self.root)
            self.assertEqual(os.environ["DOCKER_HOST"], "unix:///real.sock")
            self.assertEqual(actual["HOME"], str(self.root / "home"))
            self.assertEqual(actual["DOCKER_CONFIG"], str(self.root / "docker-config"))
            self.assertEqual({key for key in actual if key.startswith("DOCKER_")}, {"DOCKER_CONFIG"})
            self.assertNotIn("COLIMA_HOME", actual)
            self.assertNotIn("LIMA_HOME", actual)
            self.assertFalse(any(key.startswith(("COMPOSE_", "BUILDX_", "BUILDKIT_")) for key in actual))
        self.assertEqual(dict(os.environ), before)
        config = json.loads((self.root / "home/Library/Application Support/io.github.jgoneit.docker2u/runtime.json").read_text())
        self.assertEqual(config, {"dockerPath": str(self.root / "docker")})
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)

    def test_read_only_protocol_and_explicit_endpoint(self):
        cases = [(["--version"], b"Docker version"), (["context", "inspect"], b"native-smoke-local"),
                 (self.host + ["info", "--format", "{{json .}}"], b"native-smoke-engine"),
                 (self.host + ["version", "--format", "{{json .}}"], b'"Server"'),
                 (self.host + ["container", "ls", "--all", "--no-trunc", "--format", "{{json .}}"], format(1, "064x").encode()),
                 (self.host + ["container", "inspect", "--format", docker.INSPECT_FORMAT, format(1, "064x"), format(2, "064x")], b"native-smoke-2")]
        for arguments, expected in cases:
            with self.subTest(arguments=arguments):
                result = self.cli(arguments)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(expected, result.stdout)

    def test_compose_metadata_matches_current_native_inspect_contract(self):
        source = (REPO / "src-tauri/src/docker.rs").read_text()
        current_format = source.split('const INSPECT_FORMAT: &str = r#"', 1)[1].split('"#;', 1)[0]
        self.assertEqual(docker.INSPECT_FORMAT, current_format)
        result = self.cli(self.host + ["container", "inspect", "--format", current_format, *docker.IDS])
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([row["ComposeProject"] for row in rows], ["native-smoke-project", "native-smoke-project", None])
        self.assertEqual([row["ComposeService"] for row in rows], ["api", "redis", None])

    def test_mount_metadata_is_bounded_and_shared_across_projects(self):
        source = (REPO / "src-tauri/src/docker_mounts.rs").read_text()
        current_format = source.split('const MOUNTS_FORMAT: &str = r#"', 1)[1].split('"#;', 1)[0]
        self.assertEqual(docker.MOUNTS_FORMAT, current_format)
        result = self.cli(self.host + ["container", "inspect", "--format", current_format, *docker.IDS])
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([row["Id"] for row in rows], docker.IDS)
        self.assertEqual({row["Mounts"][0]["Source"] for row in rows}, {rows[0]["Mounts"][0]["Source"]})
        self.assertTrue(rows[0]["Mounts"][1]["RW"])
        self.assertFalse(rows[1]["Mounts"][1]["RW"])
        self.assertEqual(rows[1]["Mounts"][2]["Type"], "tmpfs")
        self.assertTrue(all(set(row) == {"Id", "Mounts"} for row in rows))
        rejected = self.cli(self.host + ["container", "inspect", "--format", current_format, docker.IDS[0], docker.IDS[0]])
        self.assertNotEqual(rejected.returncode, 0)

    def test_details_accepts_only_the_current_bounded_single_target_inspect(self):
        source = (REPO / "src-tauri/src/docker_details.rs").read_text()
        current_format = source.split('const DETAILS_FORMAT: &str = r#"', 1)[1].split('"#;', 1)[0]
        self.assertEqual(docker.DETAILS_FORMAT, current_format)
        result = self.cli(self.host + ["container", "inspect", "--format", current_format, docker.IDS[0]])
        self.assertEqual(result.returncode, 0, result.stderr)
        row = json.loads(result.stdout)
        self.assertEqual((row["Id"], row["ExitCode"], row["OOMKilled"], row["HealthConfigured"]), (docker.IDS[0], 137, False, True))
        self.assertEqual(row["Health"]["Log"][0]["Output"], "NATIVE_SMOKE_HEALTH_FAILURE <b>refused</b>")
        self.assertEqual([binding["HostIp"] for binding in row["Ports"]["5432/tcp"]], ["0.0.0.0", "::"])
        self.assertNotIn("Config", row)
        self.assertNotIn("Env", row)
        self.assertEqual(next(event for event in fixture.read_trace(self.root) if event["phase"] == "details-payload")["fullId"], docker.IDS[0])
        for arguments in [[current_format, *docker.IDS[:2]], [current_format + " ", docker.IDS[0]], [current_format, format(4, "064x")]]:
            with self.subTest(arguments=arguments):
                rejected = self.cli(self.host + ["container", "inspect", "--format", *arguments])
                self.assertEqual(rejected.returncode, 95)
                self.assertEqual(rejected.stdout, b"")

    def test_stats_samples_only_explicit_full_ids_in_one_batch(self):
        targets = [docker.IDS[1], docker.IDS[0]]
        result = self.cli(self.host + ["container", "stats", "--no-stream", "--no-trunc", "--format", "{{json .}}", *targets])
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([row["ID"] for row in rows], targets)
        self.assertEqual(rows[1]["CPUPerc"], "125.50%")
        self.assertEqual(rows[1]["MemUsage"], "64MiB / 2GiB")
        self.assertEqual(rows[1]["MemPerc"], "3.125%")
        event = next(row for row in fixture.read_trace(self.root) if row["phase"] == "stats-payload")
        self.assertEqual(event["fullIds"], targets)
        self.assertEqual(event["count"], 2)

    def test_follow_remains_open_and_only_emits_ticks_when_owned_gate_is_enabled(self):
        arguments = self.host + ["container", "logs", "--follow", "--tail", "300", "--timestamps", docker.IDS[0]]
        stdout_path, stderr_path = self.root / "follow.stdout", self.root / "follow.stderr"
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            process = subprocess.Popen([sys.executable, str(self.root / "docker"), *arguments], env=self.environment, stdout=stdout, stderr=stderr, start_new_session=True)
            try:
                def wait_for(check):
                    deadline = time.monotonic() + 5
                    while not check():
                        self.assertIsNone(process.poll(), "follow exited before cancellation")
                        self.assertLess(time.monotonic(), deadline, "follow fixture did not produce expected evidence")
                        time.sleep(0.02)

                wait_for(lambda: any(row["phase"] == "follow-ready" for row in fixture.read_trace(self.root)))
                self.assertEqual(stdout_path.read_bytes(), docker.dense_logs(identity()))
                self.assertFalse(any(row["phase"] == "follow-output" for row in fixture.read_trace(self.root)))
                gate = self.root / "follow-live"
                gate.write_text("enabled")
                wait_for(lambda: any(row["phase"] == "follow-output" and row["sequence"] >= 2 for row in fixture.read_trace(self.root)))
                gate.unlink()
                time.sleep(0.1)
                before = len([row for row in fixture.read_trace(self.root) if row["phase"] == "follow-output"])
                time.sleep(0.35)
                self.assertEqual(len([row for row in fixture.read_trace(self.root) if row["phase"] == "follow-output"]), before)
                self.assertIsNone(process.poll())
                process.terminate()
                self.assertEqual(process.wait(timeout=3), 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=3)
        self.assertIn(b"NATIVE_SMOKE_LIVE_STDOUT 2", stdout_path.read_bytes())
        self.assertIn(b"NATIVE_SMOKE_LIVE_STDERR 2", stderr_path.read_bytes())
        self.assertIn("한글".encode(), stderr_path.read_bytes())
        events = fixture.read_trace(self.root)
        self.assertEqual(events[-2]["phase"], "follow-stopped")
        self.assertEqual(events[-1]["phase"], "end")
        self.assertEqual(events[-1]["exitCode"], 0)

    def test_mutations_foreign_hosts_and_unknown_containers_are_rejected(self):
        cases = [self.host + ["container", action, format(1, "064x")] for action in ["start", "stop", "restart", "rm"]]
        cases += [["--host", "unix:///real.sock", "info", "--format", "{{json .}}"],
                  ["info", "--format", "{{json .}}"],
                  self.host + ["container", "logs", "--tail", "300", "--timestamps", "$(touch forbidden)"],
                  self.host + ["container", "inspect", "--format", "foreign-format", format(1, "064x")],
                  self.host + ["container", "inspect", "--format", docker.INSPECT_FORMAT, format(4, "064x")],
                  self.host + ["container", "stats", "--no-stream", "--no-trunc", "--format", "{{json .}}"],
                  self.host + ["container", "stats", "--no-stream", "--no-trunc", "--format", "{{json .}}", docker.IDS[0], docker.IDS[0]],
                  self.host + ["container", "stats", "--no-stream", "--no-trunc", "--format", "{{json .}}", format(4, "064x")],
                  self.host + ["container", "logs", "--follow", "--tail", "all", "--timestamps", docker.IDS[0]],
                  self.host + ["container", "logs", "--follow", "--tail", "300", "--timestamps", "$(touch forbidden)"]]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                result = self.cli(arguments)
                self.assertEqual(result.returncode, 95)
                self.assertEqual(result.stdout, b"")

    def test_armed_info_failure_is_claimed_once_and_restores_identity(self):
        (self.root / "arm-engine-change").write_text("armed")
        with patch.object(docker.time, "sleep") as sleep:
            output = io.StringIO()
            with redirect_stdout(output):
                docker.run(self.root, self.host + ["info", "--format", "{{json .}}"])
            sleep.assert_called_once_with(3)
            self.assertEqual(json.loads(output.getvalue())["ID"], "changed-engine")
        output = io.StringIO()
        with redirect_stdout(output):
            docker.run(self.root, self.host + ["info", "--format", "{{json .}}"])
        self.assertEqual(json.loads(output.getvalue())["ID"], "native-smoke-engine")
        self.assertEqual([row["phase"] for row in fixture.read_trace(self.root)], ["held-info", "engine-change-reply"])

    def test_existing_directory_cannot_be_claimed_or_deleted(self):
        preserved = self.root / "user-data"
        preserved.write_text("preserve")
        with self.assertRaises(FileExistsError):
            fixture.serve(self.root, self.root / "absent.app", self.root / "evidence")
        self.assertEqual(preserved.read_text(), "preserve")

    def test_early_setup_error_removes_only_new_owned_directory(self):
        new_root = self.root.parent / "new-owned"
        # Validate the binary before allocating a listening socket or launching.
        with self.assertRaises(FileNotFoundError):
            fixture.serve(new_root, self.root / "absent.app", self.root / "evidence")
        self.assertFalse(new_root.exists())
        self.assertTrue(self.root.exists())



class ComposeFixtureTests(unittest.TestCase):
    setUp = FixtureIsolationTests.setUp
    cli = FixtureIsolationTests.cli

    def compose_arguments(self, command, name="native-compose", source=None):
        directory = self.root / "compose project 한글"
        return self.host + ["compose", "--ansi", "never", "--progress", "plain",
                            "--project-directory", str(directory), "--project-name", name,
                            "--file", str(source or directory / "compose.yaml"),
                            "--env-file", str(directory / ".env"), *command]

    def compose_environment(self):
        return {**self.environment, "DOCKER_HOST": self.host[1], "COMPOSE_REMOVE_ORPHANS": "false",
                "COMPOSE_PROFILES": "", "COMPOSE_MENU": "false", "BUILDX_BUILDER": "default"}

    def compose_cli(self, command, name="native-compose", source=None, environment=None):
        return subprocess.run([sys.executable, str(self.root / "docker"), *self.compose_arguments(command, name, source)],
                              cwd=self.root / "compose project 한글", env=environment or self.compose_environment(),
                              capture_output=True, timeout=5)

    def require_up(self):
        result = self.compose_cli(["up", "--detach"])
        self.assertEqual(result.returncode, 0, result.stderr)
        return docker.compose.rows(self.root)

    def apply_command(self, *services):
        return ["up", "--detach", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "--", *services]

    def test_apply_preparation_changes_images_without_recreating_containers(self):
        before = self.require_up()
        self.assertEqual(self.compose_cli(["pull", "--policy", "always", "--", "api"]).returncode, 0)
        self.assertEqual(docker.compose.rows(self.root), before)
        self.assertEqual(self.compose_cli(["build", "--", "worker"]).returncode, 0)
        built = docker.compose.images(self.root)["native-compose-worker"]["dockerfileDigest"]
        (self.root / "compose project 한글/Dockerfile").write_text("FROM scratch\nLABEL fixture=changed\n")
        self.assertEqual(self.compose_cli(["build", "--", "worker"]).returncode, 0)
        self.assertNotEqual(docker.compose.images(self.root)["native-compose-worker"]["dockerfileDigest"], built)
        self.assertEqual(docker.compose.rows(self.root), before)
        self.assertEqual(self.compose_cli(self.apply_command("worker")).returncode, 0)
        after = docker.compose.rows(self.root)
        self.assertEqual(next(row for row in before if row["ComposeService"] == "api"),
                         next(row for row in after if row["ComposeService"] == "api"))
        self.assertNotEqual(next(row for row in before if row["ComposeService"] == "worker")["Id"],
                            next(row for row in after if row["ComposeService"] == "worker")["Id"])

    def test_apply_missing_local_image_does_not_implicitly_prepare(self):
        result = self.compose_cli(self.apply_command("api"))
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"NATIVE_COMPOSE_MISSING_LOCAL_IMAGE", result.stdout)
        self.assertEqual(docker.compose.images(self.root), {})
        self.assertEqual(docker.compose.rows(self.root), [])

    def test_apply_preparation_failure_preserves_existing_containers_and_prior_images(self):
        before = self.require_up()
        self.assertEqual(self.compose_cli(["pull", "--policy", "always", "--", "api"]).returncode, 0)
        prepared = docker.compose.images(self.root)
        (self.root / "compose-mode").write_text("build-fail")
        self.assertEqual(self.compose_cli(["build", "--", "worker"]).returncode, 1)
        self.assertEqual(docker.compose.rows(self.root), before)
        self.assertEqual(docker.compose.images(self.root), prepared)

    def test_apply_catalog_can_include_profiles_without_activating_them(self):
        source = self.root / "compose project 한글/compose.yaml"
        model = json.loads(source.read_text())
        model["services"]["debug"] = {"image": "debug:fixture", "profiles": ["tools"]}
        source.write_text(json.dumps(model))
        result = self.compose_cli(["--profile", "*", "config", "--format", "json"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("debug", json.loads(result.stdout)["services"])
        self.assertNotIn("debug", [row["ComposeService"] for row in self.require_up()])
        self.assertEqual(self.compose_cli(["pull", "--policy", "always", "--", "debug"]).returncode, 0)
        self.assertEqual(self.compose_cli(self.apply_command("debug")).returncode, 0)
        self.assertIn("debug", [row["ComposeService"] for row in docker.compose.rows(self.root)])
        self.assertEqual(self.compose_cli(["--profile", "*", *self.apply_command("debug")]).returncode, 95)

    def test_apply_fixture_rejects_empty_unknown_and_unbounded_commands(self):
        for command in [["pull", "--policy", "always", "--"], ["build", "--", "unknown"],
                        self.apply_command(), self.apply_command("api", "api"),
                        ["up", "--detach", "--force-recreate", "api"], ["build", "--push", "--", "worker"]]:
            with self.subTest(command=command):
                self.assertEqual(self.compose_cli(command).returncode, 95)
        self.assertEqual(docker.compose.rows(self.root), [])

    def test_version_help_and_config_match_core_contract_without_secret_in_trace(self):
        for command, expected in [(["version", "--short"], b"2.39.4"), (["--help"], b"--project-directory"),
                                  (["config", "--help"], b"--format"), (["up", "--help"], b"--detach"),
                                  (["stop", "--help"], b"--timeout")]:
            result = subprocess.run([sys.executable, str(self.root / "docker"), *self.host, "compose", *command],
                                    env=self.compose_environment(), capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(expected, result.stdout)
        result = self.compose_cli(["config", "--format", "json"])
        self.assertEqual(result.returncode, 0, result.stderr)
        model = json.loads(result.stdout)
        self.assertEqual(model["name"], "native-compose")
        self.assertEqual(set(model["services"]), {"api", "worker"})
        self.assertIn("build", model["services"]["worker"])
        self.assertIn(docker.compose.SECRET, result.stdout.decode())
        self.assertNotIn(docker.compose.SECRET, (self.root / "trace.jsonl").read_text())
        self.assertEqual(docker.compose.rows(self.root), [])

    def test_project_lifecycle_preserves_provenance_and_changes_full_ids_on_recreation(self):
        filtered = self.host + ["container", "ls", "--all", "--no-trunc", "--filter",
                                "label=com.docker.compose.project=native-compose", "--format", "{{.ID}}"]
        self.assertEqual(self.cli(filtered).stdout, b"")
        before = self.require_up()
        identifiers = [row["Id"] for row in before]
        self.assertEqual(len(identifiers), 2)
        self.assertEqual(len(set(identifiers)), 2)
        self.assertTrue(all(len(identifier) == 64 for identifier in identifiers))
        self.assertEqual(self.cli(filtered).stdout.decode().splitlines(), identifiers)
        source = (REPO / "src-tauri/src/docker_compose.rs").read_text()
        projection = source.split('const PROVENANCE_FORMAT: &str = r#"', 1)[1].split('"#;', 1)[0]
        self.assertEqual(docker.compose.PROVENANCE_FORMAT, projection)
        result = self.cli(self.host + ["container", "inspect", "--format", projection, *identifiers])
        self.assertEqual(result.returncode, 0, result.stderr)
        provenance = [json.loads(line) for line in result.stdout.splitlines()]
        for row in provenance:
            self.assertEqual(row["Project"], "native-compose")
            self.assertEqual(row["WorkingDirectory"], str(self.root / "compose project 한글"))
            self.assertEqual(row["ConfigFiles"], str(self.root / "compose project 한글/compose.yaml"))
            self.assertEqual(set(row), {"Id", "Project", "WorkingDirectory", "ConfigFiles"})
        result = self.cli(self.host + ["container", "stats", "--no-stream", "--no-trunc", "--format", "{{json .}}", *identifiers])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([json.loads(line)["ID"] for line in result.stdout.splitlines()], identifiers)
        for row in before:
            result = self.cli(self.host + ["container", "inspect", "--format", docker.DETAILS_FORMAT, row["Id"]])
            self.assertEqual(result.returncode, 0, result.stderr)
            details = json.loads(result.stdout)
            self.assertEqual(details["Id"], row["Id"])
            self.assertEqual(details["State"], "running")
            self.assertEqual(details["HealthConfigured"], row["ComposeService"] == "api")
            self.assertFalse(details["OOMKilled"])
            result = self.cli(self.host + ["container", "logs", "--tail", "300", "--timestamps", row["Id"]])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, docker.dense_logs(identity()))
        result = self.compose_cli(["stop"])
        self.assertEqual(result.returncode, 0, result.stderr)
        stopped = docker.compose.rows(self.root)
        self.assertEqual([row["Id"] for row in stopped], identifiers)
        self.assertTrue(all(row["State"] == "exited" for row in stopped))
        newer = self.require_up()
        self.assertTrue(set(identifiers).isdisjoint(row["Id"] for row in newer))
        stale = self.cli(self.host + ["container", "inspect", "--format", docker.INSPECT_FORMAT, identifiers[0]])
        self.assertEqual(stale.returncode, 95)
        self.assertEqual(stale.stdout, b"")

    def test_partial_failure_leaves_observable_started_service_and_other_project_untouched(self):
        first = self.compose_cli(["up", "--detach"], name="another-project")
        self.assertEqual(first.returncode, 0, first.stderr)
        existing = docker.compose.rows(self.root)
        (self.root / "compose-mode").write_text("fail")
        result = self.compose_cli(["up", "--detach"])
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"NATIVE_COMPOSE_PARTIAL_FAILURE", result.stdout)
        current = docker.compose.rows(self.root)
        self.assertEqual([row for row in current if row["ComposeProject"] == "another-project"], existing)
        partial = [row for row in current if row["ComposeProject"] == "native-compose"]
        self.assertEqual(len(partial), 1)
        self.assertEqual(partial[0]["ComposeService"], "api")
        self.assertEqual(partial[0]["State"], "running")
        (self.root / "compose-mode").write_text("success")
        self.assertEqual(self.compose_cli(["stop"]).returncode, 0)
        self.assertEqual([row for row in docker.compose.rows(self.root) if row["ComposeProject"] == "another-project"], existing)

    def test_config_failures_and_foreign_or_ambient_inputs_are_rejected(self):
        result = self.compose_cli(["config", "--format", "json"], source=self.root / "compose project 한글/invalid.yaml")
        self.assertEqual(result.returncode, 95)
        self.assertEqual(result.stdout, b"")
        (self.root / "compose-config-fail").write_text("missing required variable")
        self.assertEqual(self.compose_cli(["config", "--format", "json"]).returncode, 1)
        (self.root / "compose-config-fail").unlink()
        cases = [{"DOCKER_HOST": "unix:///foreign.sock"}, {"COMPOSE_REMOVE_ORPHANS": "true"},
                 {"COMPOSE_FILE": "/foreign/compose.yaml"}, {"COMPOSE_ENV_FILES": "/foreign/env"},
                 {"BUILDX_BUILDER": "remote"}, {"BUILDKIT_HOST": "tcp://foreign:1234"}]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                result = self.compose_cli(["up", "--detach"], environment={**self.compose_environment(), **overrides})
                self.assertEqual(result.returncode, 95)
                self.assertEqual(result.stdout, b"")
        without_builder_pin = self.compose_environment()
        del without_builder_pin["BUILDX_BUILDER"]
        result = self.compose_cli(["up", "--detach"], environment=without_builder_pin)
        self.assertEqual(result.returncode, 95, "clearing builder variables must not fall back to a persisted selection")
        self.assertEqual(result.stdout, b"")
        for command in [["down"], ["up", "--detach", "--remove-orphans"], ["exec", "api", "sh"], ["build"]]:
            self.assertEqual(self.compose_cli(command).returncode, 95)
        self.assertEqual(docker.compose.rows(self.root), [])

    def test_quiet_operation_and_blocked_configuration_cancel_without_later_mutation(self):
        for command, marker, expected_phase in [(["up", "--detach"], "compose-mode", "compose-operation"),
                                                (["config", "--format", "json"], "compose-config-block", "compose-config")]:
            with self.subTest(command=command):
                (self.root / marker).write_text("quiet")
                process = subprocess.Popen([sys.executable, str(self.root / "docker"), *self.compose_arguments(command)],
                                           cwd=self.root / "compose project 한글", env=self.compose_environment(),
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                try:
                    deadline = time.monotonic() + 5
                    while not any(row["phase"] == expected_phase and row["pid"] == process.pid for row in fixture.read_trace(self.root)):
                        self.assertIsNone(process.poll())
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(0.02)
                    time.sleep(0.05)
                    self.assertIsNone(process.poll())
                    process.terminate()
                    stdout, stderr = process.communicate(timeout=3)
                    self.assertEqual(process.returncode, 130, stderr)
                    self.assertNotIn(b"NATIVE_COMPOSE_END", stdout)
                    self.assertEqual(docker.compose.rows(self.root), [])
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate(timeout=3)
                    (self.root / marker).unlink()


class EvidenceValidationTests(unittest.TestCase):
    def test_compose_ipc_metadata_does_not_award_ui_coverage(self):
        report = {**clear_report(), "status": "ready", "steps": [
            step("compose picker", 1100, {"kind": "file", "selected": True}),
            step("compose preview", 1200, {"name": "native-compose", "services": ["api", "worker"], "existingContainers": 0}),
            step("compose registered", 1300, {"id": "registration-id", "name": "native-compose", "revision": 1}),
            step("compose prepared", 1400, {"name": "native-compose", "action": "up", "existingContainers": 0}),
            step("compose started", 1500, {"id": "operation-id", "action": "up", "phase": "preparing"}),
            step("compose phase", 1600, {"id": "operation-id", "action": "up", "phase": "finished", "outcome": "succeeded", "reconciliation": "succeeded", "observedContainers": 2, "errorCode": None}),
            step("compose cancelled", 1700, {"id": "another-operation", "phase": "running", "cancelRequested": True}),
            step("compose preview failed", 1800, {"code": "ComposeValidationFailed"}),
        ]}
        result = fixture.validate_ui(identity(), report, [], now_ms=5000)
        self.assertTrue(result["accepted"])
        self.assertTrue(result["metadataOnly"])
        self.assertFalse(result["composeUiVerified"])
        self.assertEqual(result["completedProbes"], [])
        self.assertEqual(result["metadataEvidence"], report["steps"])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "fixture"
            root.mkdir()
            evidence = Path(directory) / "evidence"
            submissions = evidence / "ui-results"
            submissions.mkdir(parents=True)
            fixture.write_json(submissions / "compose.json", {"ui": report, "verification": result})
            summary = fixture.archive_trace({**identity(), "fixtureRoot": str(root), "evidenceDirectory": str(evidence)})
            self.assertFalse(summary["requiredCoverageComplete"])
            self.assertFalse(summary["observationCoverageComplete"])

    def test_compose_metadata_keeps_existing_probe_coverage_and_rejects_raw_payloads(self):
        report = clear_report()
        metadata = step("compose picker", 4500, {"kind": "file", "selected": True})
        report["steps"].append(metadata)
        result = fixture.validate_ui(identity(), report, native_events(), now_ms=5000)
        self.assertEqual(result["completedProbes"], ["connection-clear"])
        self.assertFalse(result["metadataOnly"])
        self.assertFalse(result["composeUiVerified"])
        for fields in [{"kind": "file", "selected": True, "environment": {"SECRET": "hidden"}},
                       {"kind": "file", "selected": "yes"}, {"kind": "unknown", "selected": True}]:
            changed = copy.deepcopy(report)
            changed["steps"][-1]["detail"] = fields
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                fixture.validate_ui(identity(), changed, native_events(), now_ms=5000)
        forged = {**report, "steps": [step("started compose", 1100), step("passed compose", 1200)]}
        with self.assertRaisesRegex(ValueError, "no matching probe"):
            fixture.validate_ui(identity(), forged, [], now_ms=5000)

    def test_apply_cancelled_metadata_remains_separate_from_native_ui_coverage(self):
        detail = {"id": "apply-operation", "action": "apply", "phase": "finished", "outcome": "cancelled", "reconciliation": "succeeded", "observedContainers": 0, "errorCode": "Cancelled"}
        report = {**clear_report(), "status": "ready", "steps": [step("compose phase", 1100, detail)]}
        result = fixture.validate_ui(identity(), report, [], now_ms=5000)
        self.assertTrue(result["accepted"])
        self.assertTrue(result["metadataOnly"])
        self.assertFalse(result["composeUiVerified"])
        self.assertEqual(result["completedProbes"], [])
        for changed in [{**detail, "action": "push"}, {**detail, "output": "private build output"}, {**detail, "outcome": "rolledBack"}]:
            report["steps"] = [step("compose phase", 1100, changed)]
            with self.subTest(detail=changed), self.assertRaises(ValueError):
                fixture.validate_ui(identity(), report, [], now_ms=5000)

    def test_accepts_same_pid_order_with_launch_and_binary_binding(self):
        result = fixture.validate_ui(identity(), clear_report(), native_events(), now_ms=5000)
        self.assertTrue(result["accepted"])
        self.assertEqual(result["clearOrderProofs"][0]["nativePid"], 41)

    def test_rejects_another_launch_binary_or_clock_window(self):
        for key, value in [("runId", "another-run"), ("binarySha256", "b" * 64), ("startedAtMs", 999)]:
            report = clear_report()
            report["binding"][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "exact native launch"):
                fixture.validate_ui(identity(), report, native_events(), now_ms=5000)
        report = clear_report()
        report["steps"][0]["timeMs"] = 999
        with self.assertRaisesRegex(ValueError, "outside this native launch"):
            fixture.validate_ui(identity(), report, native_events(), now_ms=5000)

    def test_rejects_clear_before_request_or_native_hold_and_unrelated_reply(self):
        for transform in [lambda rows: rows[0].update(timeMs=1600), lambda rows: rows[1].update(pid=99), lambda rows: rows[1].update(timeMs=1400)]:
            events = native_events()
            transform(events)
            with self.assertRaisesRegex(ValueError, "Native order proof failed"):
                fixture.validate_ui(identity(), clear_report(), events, now_ms=5000)
        report = clear_report()
        report["steps"][1]["timeMs"] = 1550
        with self.assertRaisesRegex(ValueError, "out of order"):
            fixture.validate_ui(identity(), report, native_events(), now_ms=5000)

    def test_failed_incomplete_or_non_native_ui_cannot_pass(self):
        for key, value in [("status", "running"), ("failures", ["earlier attempt failed"]), ("nativeIpc", False)]:
            report = clear_report()
            report[key] = value
            with self.assertRaisesRegex(ValueError, "incomplete or failed"):
                fixture.validate_ui(identity(), report, native_events(), now_ms=5000)
        report = clear_report()
        report["steps"].pop()
        with self.assertRaisesRegex(ValueError, "no complete probe"):
            fixture.validate_ui(identity(), report, native_events(), now_ms=5000)

    def test_status_and_stop_archival_preserve_verified_ui_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "fixture"
            root.mkdir()
            evidence = Path(directory) / "evidence"
            submissions = evidence / "ui-results"
            submissions.mkdir(parents=True)
            manifest = {**identity(), "fixtureRoot": str(root), "evidenceDirectory": str(evidence), "status": "running"}
            accepted = {"ui": clear_report(), "verification": fixture.validate_ui(identity(), clear_report(), native_events(), now_ms=5000)}
            fixture.write_json(submissions / "worker.json", accepted)
            (root / "trace.jsonl").write_text("\n".join(json.dumps(row) for row in native_events()) + "\n")
            self.assertEqual(fixture.archive_trace(manifest)["uiReports"], [accepted])
            manifest.update(status="stopped", finishedAtMs=5000)
            self.assertEqual(fixture.archive_trace(manifest)["uiReports"], [accepted])
            self.assertFalse(fixture.archive_trace(manifest)["requiredCoverageComplete"])

    def test_search_requires_real_payload_worker_and_visible_coordinates(self):
        coordinates = {"viewport": {"top": 100, "bottom": 300}, "match": {"top": 200, "bottom": 219}}
        report = {**clear_report(), "steps": [step("started search", 1100), step("2 MiB dense count", 1200, {"total": 2097000}),
                    step("last dense match visible", 1500, coordinates), step("latest marker visible", 1600, coordinates),
                    step("search backend verified", 1700), step("passed search", 1800)],
                  "workerEvents": [step("ready", 1100), step("result", 1200, {"total": 2097000}), step("located", 1400)]}
        events = [{"phase": "logs-payload", "pid": 41, "timeMs": 1050, "byteCount": 2097152, "aCount": 2097000}]
        self.assertTrue(fixture.validate_ui(identity(), report, events, now_ms=5000)["accepted"])
        for field in ["worker", "viewport", "payload"]:
            changed, trace = copy.deepcopy(report), copy.deepcopy(events)
            if field == "worker":
                changed["workerEvents"] = []
            elif field == "viewport":
                changed["steps"][2]["detail"]["match"]["bottom"] = 800
            else:
                trace[0]["byteCount"] = 1024
            with self.subTest(field=field), self.assertRaises(ValueError):
                fixture.validate_ui(identity(), changed, trace, now_ms=5000)

    def test_socket_probe_requires_removal_before_request_without_early_restore(self):
        report = {**clear_report(), "steps": [step("started socket", 1200), step("requested missing-socket logs", 1300), step("native SocketMissing verified", 1500), step("passed socket", 1600)]}
        events = [{"phase": "socket-off", "pid": 40, "timeMs": 1100}]
        self.assertTrue(fixture.validate_ui(identity(), report, events, now_ms=5000)["accepted"])
        for rows in [[], events + [{"phase": "socket-on", "pid": 40, "timeMs": 1400}]]:
            with self.assertRaisesRegex(ValueError, "socket was not removed"):
                fixture.validate_ui(identity(), report, rows, now_ms=5000)


class InsightEvidenceTests(unittest.TestCase):
    full_id = format(1, "064x")

    def report(self, probe, rows):
        return {**clear_report(), "steps": [step("started " + probe, 1100), *rows, step("passed " + probe, 2200)]}

    def command(self, words, timestamp=1300, pid=42):
        return [{"phase": "start", "timeMs": timestamp, "pid": pid, "args": ["--host", "unix:///owned.sock", *words]},
                {"phase": "end", "timeMs": timestamp + 10, "pid": pid, "exitCode": 0}]

    def ready(self):
        return {"phase": "follow-ready", "timeMs": 1050, "pid": 41, "fullId": self.full_id}

    def detail(self, **values):
        return {"fullId": self.full_id, "streamId": "stream-1", **values}

    def test_detail_tabs_require_native_inspect_and_retained_log_identity(self):
        report = self.report("detail-tabs", [step("captured log view before detail tabs", 1200, self.detail(starts=1)),
            step("native diagnostics and bounded health output verified", 1500, {"fullId": self.full_id, "exitCode": 137, "oomKilled": False, "healthConfigured": True, "healthFailures": 1}),
            step("native connection candidates verified", 1600, {"ipv4Candidate": "127.0.0.1:15432", "ipv6Candidate": "[::1]:15432", "alias": "native-api", "unpublishedUdp": True}),
            step("restored logs after all three tabs", 1800, self.detail(starts=1, preservedView=True, detailsReads=1, maximumActiveReads=1))])
        events = [self.ready(), *self.command(["container", "inspect", "--format", docker.DETAILS_FORMAT, self.full_id], 1300, 43),
                  {"phase": "details-payload", "timeMs": 1305, "pid": 43, "fullId": self.full_id}]
        self.assertTrue(fixture.validate_ui(identity(), report, events, now_ms=5000)["accepted"])
        for fault in ["no-payload", "wrong-target", "no-command", "no-completion", "invented-oom", "view-reset", "duplicate-read", "stream-replaced"]:
            ui, trace = copy.deepcopy(report), copy.deepcopy(events)
            if fault == "no-payload": trace.pop()
            elif fault == "wrong-target": trace[-1]["fullId"] = docker.IDS[1]
            elif fault == "no-command": trace.pop(1)
            elif fault == "no-completion": trace.pop(2)
            elif fault == "invented-oom": ui["steps"][2]["detail"]["oomKilled"] = True
            elif fault == "view-reset": ui["steps"][-2]["detail"]["preservedView"] = False
            elif fault == "duplicate-read": ui["steps"][-2]["detail"]["detailsReads"] = 2
            else: trace.append({**self.ready(), "timeMs": 1700, "pid": 99})
            with self.subTest(fault=fault), self.assertRaises(ValueError): fixture.validate_ui(identity(), ui, trace, now_ms=5000)

    def test_project_stats_requires_exact_ui_sample_successful_inspect_and_matching_native_batch(self):
        report = self.report("project-stats", [step("Compose grouping and real stats visible", 1500, {"projectRows": 2, "observedSources": 3, "cpuPercent": 125.5, "memoryUsageBytes": 67108864, "memoryLimitBytes": 2147483648, "sessionId": "native-session", "observationSequence": 1, "sampledAt": "1970-01-01T00:00:01.310Z", "fullIds": [format(n, "064x") for n in [1, 2, 3]]}), step("standalone tree navigation verified", 1600, {"standaloneRows": 1, "inventoryRows": 3, "fullId": format(3, "064x")})])
        ids = [format(number, "064x") for number in [1, 2, 3]]
        events = self.command(["container", "inspect"], 1050) + self.command(["container", "stats", "--no-stream", "--no-trunc", "--format", "{{json .}}", *ids], 1300, 43)
        events.append({"phase": "stats-payload", "timeMs": 1305, "pid": 43, "count": 3, "fullIds": ids})
        self.assertTrue(fixture.validate_ui(identity(), report, events, now_ms=5000)["accepted"])
        for fault in ["no-inspect", "no-batch", "wrong-ids", "wrong-ui", "no-command", "stale-sample", "missing-session", "wrong-count"]:
            ui, trace = copy.deepcopy(report), copy.deepcopy(events)
            if fault == "no-inspect": trace = trace[2:]
            elif fault == "no-batch": trace.pop()
            elif fault == "wrong-ids": trace[-1]["fullIds"] = [ids[0]]
            elif fault == "wrong-ui": ui["steps"][1]["detail"]["cpuPercent"] = 0
            elif fault == "stale-sample": ui["steps"][1]["detail"]["sampledAt"] = "1970-01-01T00:00:01.000Z"
            elif fault == "missing-session": ui["steps"][1]["detail"]["sessionId"] = ""
            elif fault == "wrong-count": trace[-1]["count"] = 2
            else: trace = [row for row in trace if not (row["phase"] == "start" and row["pid"] == 43)]
            with self.subTest(fault=fault), self.assertRaises(ValueError): fixture.validate_ui(identity(), ui, trace, now_ms=5000)

    def test_live_display_requires_output_from_the_same_native_process_during_each_frozen_interval(self):
        report = self.report("live-display", [step("paused live display", 1200, self.detail(beforeTick=1)),
            step("paused display while real stdout and stderr arrived", 1400, self.detail(beforeTick=1, afterTick=4, newFrames=3)),
            step("resume caught up with ring loss notice", 1450), step("search display frozen", 1500, self.detail(beforeTick=4)),
            step("search froze and resumed without restarting the stream", 1700, self.detail(afterTick=7, maximumActiveReads=1))])
        events = [self.ready(), {"phase": "follow-output", "timeMs": 1300, "pid": 41, "fullId": self.full_id, "sequence": 4}, {"phase": "follow-output", "timeMs": 1600, "pid": 41, "fullId": self.full_id, "sequence": 7}]
        self.assertTrue(fixture.validate_ui(identity(), report, events, now_ms=5000)["accepted"])
        for fault in ["missing-output", "foreign-pid", "outside-pause", "read-overlap", "restarted", "terminated-before-probe"]:
            ui, trace = copy.deepcopy(report), copy.deepcopy(events)
            if fault == "missing-output": trace.pop()
            elif fault == "foreign-pid": trace[1]["pid"] = 99
            elif fault == "outside-pause": trace[1]["timeMs"] = 1150
            elif fault == "read-overlap": ui["steps"][-2]["detail"]["maximumActiveReads"] = 2
            elif fault == "restarted": trace.append({**self.ready(), "timeMs": 1800, "pid": 99})
            else: trace.append({"phase": "follow-stopped", "timeMs": 1090, "pid": 41})
            with self.subTest(fault=fault), self.assertRaises(ValueError): fixture.validate_ui(identity(), ui, trace, now_ms=5000)

    def test_pinned_refresh_requires_native_inventory_without_another_follow(self):
        report = self.report("pinned-refresh", [step("requested inventory refresh with live stream", 1200, self.detail(starts=1)), step("inventory refreshed with the same live stream", 1500, self.detail(starts=1))])
        events = [self.ready(), *self.command(["container", "ls"])]
        self.assertTrue(fixture.validate_ui(identity(), report, events, now_ms=5000)["accepted"])
        for trace in [[self.ready()], events + [{**self.ready(), "timeMs": 1400, "pid": 99}]]:
            with self.assertRaises(ValueError): fixture.validate_ui(identity(), report, trace, now_ms=5000)

    def test_pane_resize_requires_real_geometry_restore_and_native_output_without_replacement(self):
        before = self.detail(width=320, min=280, max=440, detailWidth=800, listWidth=320, beforeTick=1, readCount=2)
        resized = self.detail(width=340, min=280, max=440, detailWidth=780, listWidth=340, key="ArrowRight", afterTick=4, newReads=3, preservedView=True)
        after = self.detail(width=320, min=280, max=440, detailWidth=800, listWidth=320, preservedView=True, maximumActiveReads=1)
        report = self.report("pane-resize", [step("captured live pane before keyboard resize", 1200, before), step("resized live pane with keyboard while receiving", 1600, resized), step("restored live pane without replacing the stream", 1800, after)])
        events = [self.ready(), {"phase": "follow-output", "timeMs": 1500, "pid": 41, "fullId": self.full_id, "sequence": 4}]
        self.assertTrue(fixture.validate_ui(identity(), report, events, now_ms=5000)["accepted"])
        for fault in ["missing-step", "no-output", "foreign-pid", "late-output", "unmoved-geometry", "out-of-bounds", "not-restored", "view-reset", "read-overlap", "replaced"]:
            ui, trace = copy.deepcopy(report), copy.deepcopy(events)
            if fault == "missing-step": ui["steps"].pop(2)
            elif fault == "no-output": trace.pop()
            elif fault == "foreign-pid": trace[-1]["pid"] = 99
            elif fault == "late-output": trace[-1]["timeMs"] = 1700
            elif fault == "unmoved-geometry": ui["steps"][2]["detail"]["listWidth"] = 320
            elif fault == "out-of-bounds": ui["steps"][2]["detail"]["max"] = 270
            elif fault == "not-restored": ui["steps"][3]["detail"]["width"] = 340
            elif fault == "view-reset": ui["steps"][2]["detail"]["preservedView"] = False
            elif fault == "read-overlap": ui["steps"][3]["detail"]["maximumActiveReads"] = 2
            else: trace.append({**self.ready(), "timeMs": 1700, "pid": 99})
            with self.subTest(fault=fault), self.assertRaises(ValueError): fixture.validate_ui(identity(), ui, trace, now_ms=5000)

    def test_clear_requires_native_stop_and_reap_then_refresh_without_restart(self):
        report = self.report("clear-cancel", [step("requested live Clear", 1200, self.detail(starts=1)), step("Clear stopped polling and remained cleared after Refresh", 1700, self.detail(starts=1, stoppedStreams=1, readsAfterClear=3))])
        events = [self.ready(), {"phase": "follow-stopped", "timeMs": 1300, "pid": 41, "fullId": self.full_id}, {"phase": "end", "timeMs": 1310, "pid": 41, "exitCode": 0}, *self.command(["container", "ls"], 1500)]
        self.assertTrue(fixture.validate_ui(identity(), report, events, now_ms=5000)["accepted"])
        for fault in ["no-stop", "no-reap", "no-refresh", "foreign-pid"]:
            trace = copy.deepcopy(events)
            if fault == "no-stop": trace.pop(1)
            elif fault == "no-reap": trace.pop(2)
            elif fault == "no-refresh": trace = trace[:3]
            else: trace[1]["pid"] = 99
            with self.subTest(fault=fault), self.assertRaises(ValueError): fixture.validate_ui(identity(), report, trace, now_ms=5000)

    def test_recovery_requires_rejected_refresh_then_fresh_session_inventory_and_logs(self):
        before = {"sessionId": "invalid-session", "starts": 1, "startRequests": 2, "listCheckedAt": "2026-09-12T00:00:00Z"}
        blocked = {**before, "request": 4, "requestedAtMs": 1210, "repliedAtMs": 1300, "errorCode": "NeedsValidation", "responseSessionId": None,
                   "renderedErrorCode": "NeedsValidation", "inventoryPreserved": True, "warningVisible": True, "recoveryBlocked": True}
        fresh = {"sessionId": "fresh-session", "responseSessionId": "fresh-session", "request": 5, "requestedAtMs": 1700, "repliedAtMs": 1800,
                 "errorCode": None, "starts": 2, "streamId": "fresh-stream", "fullId": format(3, "064x"), "warningVisible": False, "recoveryAvailable": True}
        report = self.report("recovery", [step("requested warning-preserving Refresh", 1200, before),
            step("warning retained after NeedsValidation rejected Refresh without new logs", 1500, blocked),
            step("requested explicit Reconnect", 1600, before), step("explicit reconnect restored the valid session", 2000, fresh)])
        events = [*self.command(["container", "ls"], 1700), {**self.ready(), "timeMs": 1900, "fullId": format(3, "064x")}]
        self.assertTrue(fixture.validate_ui(identity(), report, events, now_ms=5000)["accepted"])
        for fault in ["no-ipc-proof", "wrong-code", "no-rendered-error", "wrong-session", "old-reply", "changed-inventory", "lost-warning", "enabled-recovery", "new-start-request", "late-start",
                      "early-inventory", "early-logs", "early-follow", "early-api-logs", "no-fresh-inventory", "no-follow", "foreign-follow", "same-session", "old-fresh-reply", "same-start-count", "still-warned", "still-blocked"]:
            ui, trace = copy.deepcopy(report), copy.deepcopy(events)
            rejected, restored = ui["steps"][2]["detail"], ui["steps"][4]["detail"]
            if fault == "no-ipc-proof": rejected.pop("request")
            elif fault == "wrong-code": rejected["errorCode"] = "Busy"
            elif fault == "no-rendered-error": rejected.pop("renderedErrorCode")
            elif fault == "wrong-session": rejected["sessionId"] = "other-session"
            elif fault == "old-reply": rejected["requestedAtMs"] = 1190
            elif fault == "changed-inventory": rejected["listCheckedAt"] = "2026-09-12T00:00:01Z"
            elif fault == "lost-warning": rejected["warningVisible"] = False
            elif fault == "enabled-recovery": rejected["recoveryBlocked"] = False
            elif fault == "new-start-request": rejected["startRequests"] += 1
            elif fault == "late-start": ui["steps"][3]["detail"]["starts"] += 1
            elif fault == "early-inventory": trace.extend(self.command(["container", "ls"], 1250))
            elif fault == "early-logs": trace.extend(self.command(["container", "logs"], 1550))
            elif fault == "early-follow": trace.append({**self.ready(), "timeMs": 1400})
            elif fault == "early-api-logs": trace.append({"phase": "api-log-binding", "timeMs": 1550})
            elif fault == "no-fresh-inventory": trace = trace[-1:]
            elif fault == "no-follow": trace.pop()
            elif fault == "foreign-follow": trace[-1]["fullId"] = self.full_id
            elif fault == "same-session": restored["sessionId"] = restored["responseSessionId"] = "invalid-session"
            elif fault == "old-fresh-reply": restored["requestedAtMs"] = 1590
            elif fault == "same-start-count": restored["starts"] = 1
            elif fault == "still-warned": restored["warningVisible"] = True
            elif fault == "still-blocked": restored["recoveryAvailable"] = False
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                fixture.validate_ui(identity(), ui, trace, now_ms=5000)


if __name__ == "__main__":
    unittest.main()
