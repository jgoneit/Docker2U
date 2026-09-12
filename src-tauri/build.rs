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
            "configure_observation",
            "read_observation",
            "hold_observation",
            "release_observation_hold",
            "retry_observation_events",
            "configure_project_logs",
            "query_project_logs",
            "retry_project_logs",
            "stop_project_logs",
        ]),
    ))
    .expect("failed to generate the explicit application permissions");
}
