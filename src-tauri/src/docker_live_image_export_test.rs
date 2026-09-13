//! Opt-in image archive round trip through the production Core export API.
use super::*;
use std::{fs, thread, time::Instant};

const OWNER: &str = "io.github.jgoneit.docker2u.image-export-smoke";
const BASE: &str =
    "busybox@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0";

struct OwnedExport {
    core: Core,
    session: Session,
    root: PathBuf,
    nonce: String,
    cleaned: bool,
}

impl OwnedExport {
    fn command(&self, arguments: &[&str]) -> Result<Vec<u8>> {
        self.core.verify(&self.session.target)?;
        self.core.docker(&self.session.target, arguments, 120)
    }

    fn inspect(&self, kind: &str, id: &str) -> Result<Value> {
        serde_json::from_slice::<Vec<Value>>(&self.command(&[kind, "inspect", id])?)
            .map_err(|error| malformed(error.to_string()))?
            .into_iter()
            .next()
            .ok_or_else(|| malformed("Missing owned fixture inspect result"))
    }

    fn owned_ids(&self, kind: &str) -> Result<Vec<String>> {
        let filter = format!("label={OWNER}={}", self.nonce);
        let arguments = if kind == "container" {
            vec![
                kind,
                "ls",
                "--all",
                "--quiet",
                "--no-trunc",
                "--filter",
                &filter,
            ]
        } else {
            vec![kind, "ls", "--quiet", "--no-trunc", "--filter", &filter]
        };
        let mut ids: Vec<_> = String::from_utf8(self.command(&arguments)?)
            .map_err(|error| malformed(error.to_string()))?
            .lines()
            .map(str::to_owned)
            .collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    }

    fn remove_owned(&self, kind: &str) -> Result<()> {
        for id in self.owned_ids(kind)? {
            if !valid_id(id.strip_prefix("sha256:").unwrap_or(&id)) {
                return Err(ApiError::new(
                    "InvalidSelection",
                    "Fixture ID is not an exact digest",
                ));
            }
            let details = self.inspect(kind, &id)?;
            if details["Config"]["Labels"][OWNER] != self.nonce {
                return Err(ApiError::new(
                    "InvalidSelection",
                    "Fixture ownership changed",
                ));
            }
            if kind == "container" {
                self.command(&[kind, "rm", "--force", &id])?;
            } else {
                // No force, prune, or shared base-image removal.
                self.command(&[kind, "rm", &id])?;
            }
        }
        Ok(())
    }

    fn cleanup(&mut self) -> Result<()> {
        if self.cleaned {
            return Ok(());
        }
        self.remove_owned("container")?;
        self.remove_owned("image")?;
        fs::remove_dir_all(&self.root)
            .map_err(|error| ApiError::new("CleanupFailed", error.to_string()))?;
        self.cleaned = true;
        Ok(())
    }

    fn export(&self, container_id: &str, state: &str) -> PathBuf {
        let list = self.core.list_containers(&self.session.id).unwrap();
        let container = list
            .containers
            .iter()
            .find(|row| row.full_id == container_id)
            .unwrap();
        assert_eq!(container.state, state);
        let preview = self
            .core
            .prepare_image_export(&self.session.id, list.generation, &container.handle)
            .unwrap();
        let expected = self.inspect("container", container_id).unwrap();
        assert_eq!(preview.container_id, container_id);
        assert_eq!(preview.image_id, expected["Image"]);
        let path = self.root.join(format!("한글 archive {state}.tar"));
        let destination = self
            .core
            .set_image_export_destination(&self.session.id, &preview.prepare_id, path.clone())
            .unwrap();
        // A normal observation refresh while the native picker is open is allowed.
        self.core.list_containers(&self.session.id).unwrap();
        let request = uuid::Uuid::new_v4().to_string();
        self.core
            .start_image_export(
                &self.session.id,
                &preview.prepare_id,
                &destination.destination_token,
                &request,
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let operation = self
                .core
                .read_image_export(&self.session.id, &request)
                .unwrap();
            let result = serde_json::to_value(&operation).unwrap();
            if result["phase"] == "finished" {
                assert_eq!(result["outcome"], "succeeded", "{result}");
                assert_eq!(result["exitCode"], 0, "{result}");
                assert_eq!(result["imageId"], preview.image_id);
                assert_eq!(
                    result["bytesWritten"].as_u64(),
                    Some(fs::metadata(&path).unwrap().len())
                );
                break;
            }
            assert!(Instant::now() < deadline, "Export did not finish: {result}");
            thread::sleep(Duration::from_millis(50));
        }
        assert!(fs::metadata(&path).unwrap().len() > 1024);
        let after = self.inspect("container", container_id).unwrap();
        assert_eq!(expected["Id"], after["Id"]);
        assert_eq!(expected["Image"], after["Image"]);
        assert_eq!(expected["State"]["Status"], after["State"]["Status"]);
        assert_eq!(expected["State"]["StartedAt"], after["State"]["StartedAt"]);
        path
    }
}

impl Drop for OwnedExport {
    fn drop(&mut self) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // Stop the owned export worker before deleting its image or output directory,
            // including when the test's shorter deadline panics.
            self.core.cancel_all_image_exports_and_wait();
            let result = self.cleanup();
            self.core.shutdown();
            result
        }));
        if !matches!(result, Ok(Ok(()))) {
            eprintln!(
                "Owned export fixture cleanup needs attention: label {OWNER}={} at {}",
                self.nonce,
                self.root.display()
            );
        }
    }
}

#[test]
#[ignore = "Requires a local Docker Engine, the documented local BusyBox digest and DOCKER2U_REAL_IMAGE_EXPORT=1"]
fn real_image_export_round_trip_preserves_running_and_stopped_containers() {
    assert_eq!(
        std::env::var("DOCKER2U_REAL_IMAGE_EXPORT").as_deref(),
        Ok("1")
    );
    let core = Core::default();
    let environment = core.get_environment().unwrap();
    assert_eq!(environment.status, "ready", "{environment:?}");
    let session = core
        .active(environment.session_id.as_deref().unwrap())
        .unwrap();
    core.list_containers(&session.id).unwrap();
    // The opt-in test must not resolve or replace a user's mutable base tag.
    core.docker(&session.target, &["image", "inspect", BASE], 15)
        .expect("Prepare the documented immutable BusyBox digest before this opt-in test");
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let root = std::env::temp_dir().join(format!("docker2u-image-export-{nonce}"));
    fs::create_dir(&root).unwrap();
    let mut owned = OwnedExport {
        core,
        session,
        root,
        nonce,
        cleaned: false,
    };
    let baseline = owned
        .command(&[
            "container",
            "ls",
            "--all",
            "--no-trunc",
            "--format",
            "{{.ID}} {{.Image}} {{.Names}}",
        ])
        .unwrap();
    fs::write(owned.root.join("marker"), &owned.nonce).unwrap();
    fs::write(owned.root.join("Dockerfile"), format!(
        "FROM {BASE}\nLABEL {OWNER}=\"{}\"\nCOPY marker /docker2u-export-marker\nCMD [\"sh\",\"-c\",\"trap 'exit 0' TERM; while :; do sleep 1; done\"]\n", owned.nonce
    )).unwrap();
    let tag = format!("docker2u-export-{}:smoke", &owned.nonce[..12]);
    owned
        .command(&[
            "build",
            "--pull=false",
            "--network=none",
            "--tag",
            &tag,
            owned.root.to_str().unwrap(),
        ])
        .unwrap();
    let image = owned.inspect("image", &tag).unwrap();
    let image_id = image["Id"].as_str().unwrap().to_owned();
    let label = format!("{OWNER}={}", owned.nonce);
    let running = String::from_utf8(
        owned
            .command(&[
                "container",
                "run",
                "--detach",
                "--network=none",
                "--label",
                &label,
                &tag,
            ])
            .unwrap(),
    )
    .unwrap()
    .trim()
    .to_owned();
    let stopped = String::from_utf8(
        owned
            .command(&[
                "container",
                "create",
                "--network=none",
                "--label",
                &label,
                &tag,
            ])
            .unwrap(),
    )
    .unwrap()
    .trim()
    .to_owned();
    owned.command(&["container", "start", &stopped]).unwrap();
    owned
        .command(&["container", "stop", "--time", "1", &stopped])
        .unwrap();
    let running_tar = owned.export(&running, "running");
    let stopped_tar = owned.export(&stopped, "exited");
    assert_eq!(owned.owned_ids("container").unwrap().len(), 2);
    // Export did not touch either container. Remove only fixtures to prove that
    // load can recreate the image from each archive, not just find an existing ID.
    owned.remove_owned("container").unwrap();
    for archive in [running_tar, stopped_tar] {
        owned.remove_owned("image").unwrap();
        owned
            .command(&["image", "load", "--input", archive.to_str().unwrap()])
            .unwrap();
        let restored = owned.inspect("image", &image_id).unwrap();
        assert_eq!(restored["Id"], image_id);
        assert_eq!(restored["Config"]["Labels"][OWNER], owned.nonce);
    }
    let after = owned
        .command(&[
            "container",
            "ls",
            "--all",
            "--no-trunc",
            "--format",
            "{{.ID}} {{.Image}} {{.Names}}",
        ])
        .unwrap();
    assert_eq!(
        baseline, after,
        "Existing containers changed during the fixture test"
    );
    owned.cleanup().unwrap();
    owned.core.shutdown();
}
