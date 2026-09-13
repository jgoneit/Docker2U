import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import time
import unittest

import test_fixture as shared


fixture = shared.fixture
image_export = shared.load("native_smoke_image_export", Path(__file__).with_name("image_export_fixture.py"))


class ImageExportFixtureTests(unittest.TestCase):
    setUp = shared.FixtureIsolationTests.setUp
    cli = shared.FixtureIsolationTests.cli
    compose_arguments = shared.ComposeFixtureTests.compose_arguments
    compose_environment = shared.ComposeFixtureTests.compose_environment
    compose_cli = shared.ComposeFixtureTests.compose_cli
    require_up = shared.ComposeFixtureTests.require_up

    def inspect_image(self, identifier=None):
        identifier = identifier or shared.docker.IDS[0]
        result = self.cli(self.host + ["container", "inspect", "--format", image_export.IMAGE_EXPORT_FORMAT, identifier])
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_actual_image_inspect_matches_the_bounded_core_template(self):
        source = (shared.REPO / "src-tauri/src/docker_image_export.rs").read_text()
        current_format = source.split('const IMAGE_ID_FORMAT: &str = r#"', 1)[1].split('"#;', 1)[0]
        self.assertEqual(current_format, image_export.IMAGE_EXPORT_FORMAT)
        self.assertIn("{{json .Image}}", current_format)
        self.assertNotIn(".Config.Image", current_format)

    def test_inspect_returns_actual_image_id_independently_of_config_image_tag(self):
        first, second = [self.inspect_image(identifier) for identifier in shared.docker.IDS[:2]]
        self.assertNotEqual(first["ImageId"], second["ImageId"])
        self.assertEqual(set(first), {"Id", "ImageId"})
        self.assertRegex(first["ImageId"], r"^sha256:[0-9a-f]{64}$")
        listing = self.cli(self.host + ["container", "inspect", "--format", shared.docker.INSPECT_FORMAT, *shared.docker.IDS[:2]])
        rows = [json.loads(line) for line in listing.stdout.splitlines()]
        self.assertEqual(rows[0]["Image"], rows[1]["Image"])
        self.assertNotEqual(rows[0]["Image"], first["ImageId"])
        events = [row for row in fixture.read_trace(self.root) if row["phase"] == "image-export-inspect"]
        self.assertEqual([row["imageId"] for row in events], [first["ImageId"], second["ImageId"]])

    def test_save_preserves_binary_tar_and_the_exact_actual_image_config(self):
        image = self.inspect_image()
        result = self.cli(self.host + ["image", "save", "--", image["ImageId"]])
        self.assertEqual(result.returncode, 0, result.stderr)
        expected_id, expected = image_export.image_archive(image["Id"])
        self.assertEqual(image["ImageId"], expected_id)
        self.assertEqual(result.stdout, expected)
        self.assertGreater(len(result.stdout), 1024 * 1024)
        self.assertEqual(result.stderr, b"")
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
            manifest = json.load(archive.extractfile("manifest.json"))
            config = archive.extractfile(manifest[0]["Config"]).read()
            self.assertEqual("sha256:" + hashlib.sha256(config).hexdigest(), image["ImageId"])
            self.assertIsNone(manifest[0]["RepoTags"])
            with tarfile.open(fileobj=io.BytesIO(archive.extractfile(manifest[0]["Layers"][0]).read())) as layer:
                payload = layer.extractfile(image_export.LAYER_PATH).read()
                self.assertEqual(payload, bytes(range(256)) * 4096)
        event = next(row for row in fixture.read_trace(self.root) if row["phase"] == "image-save-payload")
        self.assertEqual(event["byteCount"], len(result.stdout))
        self.assertEqual(event["sha256"], hashlib.sha256(result.stdout).hexdigest())

    def test_binary_save_writes_only_to_the_callers_stdout_file_descriptor(self):
        image = self.inspect_image()
        destination = self.root / "선택한 이미지.tar"
        sentinel = self.root / "preserved.tar"
        sentinel.write_bytes(b"pre-existing archive")
        with destination.open("xb") as output:
            result = subprocess.run([sys.executable, str(self.root / "docker"), *self.host, "image", "save", "--", image["ImageId"]], env=self.environment, stdout=output, stderr=subprocess.PIPE, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(destination.read_bytes(), image_export.image_archive(image["Id"])[1])
        self.assertEqual(sentinel.read_bytes(), b"pre-existing archive")
        save = next(row for row in fixture.read_trace(self.root) if row["phase"] == "start" and row["args"][2:4] == ["image", "save"])
        self.assertNotIn(str(destination), save["args"])

    def test_failed_save_leaves_only_partial_binary_stdout_and_reports_nonzero_exit(self):
        image = self.inspect_image()
        (self.root / "image-export-mode").write_text("failed")
        result = self.cli(self.host + ["image", "save", "--", image["ImageId"]])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, image_export.image_archive(image["Id"])[1][:32768])
        self.assertIn(b"NATIVE_SMOKE_IMAGE_SAVE_FAILED", result.stderr)
        self.assertFalse(any(row["phase"] == "image-save-payload" for row in fixture.read_trace(self.root)))

    def test_quiet_save_is_cancellable_after_producing_partial_binary_output(self):
        image = self.inspect_image()
        (self.root / "image-export-mode").write_text("quiet")
        partial = self.root / "caller-owned.partial"
        with partial.open("xb") as output:
            process = subprocess.Popen([sys.executable, str(self.root / "docker"), *self.host, "image", "save", "--", image["ImageId"]], env=self.environment, stdout=output, stderr=subprocess.PIPE, start_new_session=True)
            try:
                deadline = time.monotonic() + 3
                while not any(row["phase"] == "image-save-waiting" for row in fixture.read_trace(self.root)):
                    self.assertIsNone(process.poll())
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.02)
                self.assertEqual(partial.stat().st_size, 32768)
                self.assertIsNone(process.poll())
                process.terminate()
                self.assertEqual(process.wait(timeout=3), 130)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=3)
                process.stderr.close()
        self.assertEqual(partial.stat().st_size, 32768)
        self.assertTrue(any(row["phase"] == "image-save-stopped" for row in fixture.read_trace(self.root)))

    def test_changed_container_image_is_visible_to_a_second_fixed_inspect(self):
        before = self.inspect_image()
        (self.root / "image-export-source-changed").write_text("enabled")
        after = self.inspect_image()
        self.assertEqual(after["Id"], before["Id"])
        self.assertNotEqual(after["ImageId"], before["ImageId"])
        rejected = self.cli(self.host + ["image", "save", "--", before["ImageId"]])
        self.assertEqual(rejected.returncode, 95)
        self.assertEqual(rejected.stdout, b"")

    def test_export_protocol_rejects_tags_foreign_targets_and_arbitrary_output_arguments(self):
        image = self.inspect_image()
        cases = [self.host + ["image", "save", "native-smoke:synthetic"],
                 self.host + ["image", "save", "--", "native-smoke:synthetic"],
                 self.host + ["image", "save", "--", "sha256:" + "f" * 64],
                 self.host + ["image", "save", "--output", str(self.root / "must-not-exist.tar"), image["ImageId"]],
                 self.host + ["image", "save", "--", image["ImageId"], image["ImageId"]],
                 self.host + ["container", "export", shared.docker.IDS[0]],
                 self.host + ["container", "inspect", "--format", image_export.IMAGE_EXPORT_FORMAT, *shared.docker.IDS[:2]],
                 self.host + ["container", "inspect", "--format", image_export.IMAGE_EXPORT_FORMAT, "native-smoke-1"],
                 ["--host", "unix:///foreign.sock", "image", "save", "--", image["ImageId"]]]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                result = self.cli(arguments)
                self.assertEqual(result.returncode, 95)
                self.assertEqual(result.stdout, b"")
        self.assertFalse((self.root / "must-not-exist.tar").exists())

    def test_stopped_compose_container_exports_without_restarting_or_recreating_any_service(self):
        self.require_up()
        stopped = self.compose_cli(["stop"])
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        before = shared.docker.compose.rows(self.root)
        self.assertTrue(all(row["State"] == "exited" for row in before))
        image = self.inspect_image(before[0]["Id"])
        result = self.cli(self.host + ["image", "save", "--", image["ImageId"]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, image_export.image_archive(before[0]["Id"])[1])
        self.assertEqual(shared.docker.compose.rows(self.root), before)


if __name__ == "__main__":
    unittest.main()
