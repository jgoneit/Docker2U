fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_environment",
            "list_containers",
            "get_recent_logs",
            "get_container_details",
            "get_container_stats",
            "start_log_stream",
            "read_log_stream",
            "stop_log_stream",
            "mutate_container",
            "mutate_containers",
        ]),
    ))
    .expect("failed to generate the explicit application permissions");
}
