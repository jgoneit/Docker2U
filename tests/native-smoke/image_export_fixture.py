"""Bounded image-ID inspection and binary Docker-save fixture; never calls Docker."""
import hashlib
import io
import json
import sys
import tarfile
import time

IMAGE_EXPORT_FORMAT = '{"Id":{{json .Id}},"ImageId":{{json .Image}}}'
LAYER_PATH = "synthetic-image/payload.bin"


def archive_entry(archive, name, data):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = 0o644
    info.mtime = 0
    archive.addfile(info, io.BytesIO(data))


def image_archive(container_id, changed=False):
    """Produce a deterministic image archive, including non-UTF8 layer content."""
    content = bytes(range(256)) * 4096
    layer_stream = io.BytesIO()
    with tarfile.open(fileobj=layer_stream, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        archive_entry(archive, LAYER_PATH, content)
    layer = layer_stream.getvalue()
    layer_hash = hashlib.sha256(layer).hexdigest()
    config = json.dumps({
        "architecture": "arm64", "os": "linux",
        "config": {"Labels": {"native-smoke-image": container_id, "native-smoke-revision": "changed" if changed else "original"}},
        "rootfs": {"type": "layers", "diff_ids": ["sha256:" + layer_hash]},
        "history": [{"created_by": "synthetic native image export fixture"}],
    }, separators=(",", ":"), sort_keys=True).encode()
    image_hash = hashlib.sha256(config).hexdigest()
    manifest = [{"Config": image_hash + ".json", "RepoTags": None, "Layers": [layer_hash + "/layer.tar"]}]
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        archive_entry(archive, "manifest.json", json.dumps(manifest, separators=(",", ":")).encode())
        archive_entry(archive, image_hash + ".json", config)
        archive_entry(archive, layer_hash + "/layer.tar", layer)
    return "sha256:" + image_hash, stream.getvalue()


def dispatch(root, args, identifiers, record, stopped):
    if args[:4] == ["container", "inspect", "--format", IMAGE_EXPORT_FORMAT]:
        if len(args) != 5 or args[4] not in identifiers:
            raise ValueError("fixture requires one current full container ID for image inspection")
        identifier = args[4]
        changed = (root / "image-export-source-changed").exists()
        image_id, _ = image_archive(identifier, changed)
        print(json.dumps({"Id": identifier, "ImageId": image_id}))
        record(root, phase="image-export-inspect", fullId=identifier, imageId=image_id)
        return 0
    if args[:2] != ["image", "save"]:
        return None
    if len(args) != 4 or args[2] != "--":
        raise ValueError("fixture only saves one exact image ID to stdout")
    image_id = args[3]
    changed = (root / "image-export-source-changed").exists()
    match = next((result for identifier in identifiers for result in [image_archive(identifier, changed)] if result[0] == image_id), None)
    if match is None:
        raise ValueError("fixture refuses image names, tags and unknown image IDs")
    _, payload = match
    mode_path = root / "image-export-mode"
    mode = mode_path.read_text().strip() if mode_path.exists() else "success"
    if mode not in {"success", "failed", "quiet"}:
        raise ValueError("fixture image export mode is not recognized")
    total = 0
    record(root, phase="image-save-started", imageId=image_id, mode=mode)
    for offset in range(0, len(payload), 32768):
        if stopped():
            record(root, phase="image-save-stopped", imageId=image_id, byteCount=total)
            return 130
        chunk = payload[offset:offset + 32768]
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
        total += len(chunk)
        if mode == "failed":
            print("NATIVE_SMOKE_IMAGE_SAVE_FAILED", file=sys.stderr)
            record(root, phase="image-save-failed", imageId=image_id, byteCount=total)
            return 1
        if mode == "quiet":
            record(root, phase="image-save-waiting", imageId=image_id, byteCount=total)
            while not stopped():
                time.sleep(0.02)
            record(root, phase="image-save-stopped", imageId=image_id, byteCount=total)
            return 130
        time.sleep(0.01)
    record(root, phase="image-save-payload", imageId=image_id, byteCount=total, sha256=hashlib.sha256(payload).hexdigest())
    return 0
