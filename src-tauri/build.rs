fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_environment",
            "list_containers",
            "get_recent_logs",
            "mutate_container",
        ]),
    ))
    .expect("failed to generate the explicit application permissions");
}
