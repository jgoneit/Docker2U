mod docker;
mod process;
#[cfg(all(test, unix))]
mod process_tests;

use docker::{
    Action, ApiError, BulkMutation, ComposeAction, ComposeOperation, ComposeOperationPreview,
    ComposeOperationRead, ComposeProject, ComposeProjectInput, ComposeProjectPreview,
    ContainerDetails, ContainerList, Core, Environment, LogStreamChunk, LogStreamStarted, Logs,
    Mutation, ObservationHold, ObservationRead, ObservationScope, ProjectLogPage, ProjectLogQuery,
    StatsSnapshot,
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn pick_compose_path(
    app: tauri::AppHandle,
    kind: String,
) -> Result<Option<String>, ApiError> {
    worker(move || {
        let picker = app.dialog().file();
        let selected = match kind.as_str() {
            "file" => picker
                .add_filter("Compose", &["yaml", "yml"])
                .blocking_pick_file(),
            "directory" => picker.blocking_pick_folder(),
            "env" => picker.blocking_pick_file(),
            _ => {
                return Err(ApiError {
                    code: "InvalidSelection".into(),
                    message: "Unknown Compose path kind".into(),
                    command: None,
                    stderr: None,
                });
            }
        };
        selected
            .map(|selection| {
                selection
                    .into_path()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|error| ApiError {
                        code: "InvalidSelection".into(),
                        message: format!("Cannot use the selected local path: {error}"),
                        command: None,
                        stderr: None,
                    })
            })
            .transpose()
    })
    .await
}

async fn worker<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| ApiError {
            code: "WorkerFailed".into(),
            message: format!("Native worker interrupted: {e}"),
            command: None,
            stderr: None,
        })?
}

#[tauri::command]
async fn get_environment(core: tauri::State<'_, Core>) -> Result<Environment, ApiError> {
    let core = core.inner().clone();
    worker(move || core.get_environment()).await
}
#[tauri::command]
async fn list_containers(
    core: tauri::State<'_, Core>,
    session_id: String,
) -> Result<ContainerList, ApiError> {
    let core = core.inner().clone();
    worker(move || core.list_containers(&session_id)).await
}
#[tauri::command]
async fn get_recent_logs(
    core: tauri::State<'_, Core>,
    session_id: String,
    handle: String,
) -> Result<Logs, ApiError> {
    let core = core.inner().clone();
    worker(move || core.get_recent_logs(&session_id, &handle)).await
}
#[tauri::command]
async fn get_container_details(
    core: tauri::State<'_, Core>,
    session_id: String,
    generation: u64,
    handle: String,
) -> Result<ContainerDetails, ApiError> {
    let core = core.inner().clone();
    worker(move || core.get_container_details(&session_id, generation, &handle)).await
}
#[tauri::command]
async fn get_container_stats(
    core: tauri::State<'_, Core>,
    session_id: String,
    generation: u64,
    handles: Vec<String>,
) -> Result<StatsSnapshot, ApiError> {
    let core = core.inner().clone();
    worker(move || core.get_container_stats(&session_id, generation, &handles)).await
}
#[tauri::command]
async fn start_log_stream(
    core: tauri::State<'_, Core>,
    session_id: String,
    generation: u64,
    handle: String,
) -> Result<LogStreamStarted, ApiError> {
    let core = core.inner().clone();
    worker(move || core.start_log_stream(&session_id, generation, &handle)).await
}
#[tauri::command]
async fn read_log_stream(
    core: tauri::State<'_, Core>,
    session_id: String,
    stream_id: String,
) -> Result<LogStreamChunk, ApiError> {
    core.read_log_stream(&session_id, &stream_id)
}
#[tauri::command]
async fn stop_log_stream(
    core: tauri::State<'_, Core>,
    session_id: String,
    stream_id: String,
) -> Result<(), ApiError> {
    let core = core.inner().clone();
    worker(move || core.stop_log_stream(&session_id, &stream_id)).await
}
#[tauri::command]
async fn mutate_container(
    core: tauri::State<'_, Core>,
    session_id: String,
    handle: String,
    action: Action,
) -> Result<Mutation, ApiError> {
    let core = core.inner().clone();
    worker(move || core.mutate_container(&session_id, &handle, action)).await
}

#[tauri::command]
async fn mutate_containers(
    core: tauri::State<'_, Core>,
    session_id: String,
    generation: u64,
    handles: Vec<String>,
    action: Action,
) -> Result<BulkMutation, ApiError> {
    let core = core.inner().clone();
    worker(move || core.mutate_containers(&session_id, generation, &handles, action)).await
}

#[tauri::command]
async fn configure_observation(
    core: tauri::State<'_, Core>,
    session_id: String,
    scope: ObservationScope,
) -> Result<ObservationRead, ApiError> {
    let core = core.inner().clone();
    worker(move || core.configure_observation(&session_id, scope)).await
}
#[tauri::command]
async fn read_observation(
    core: tauri::State<'_, Core>,
    session_id: String,
    after_sequence: Option<u64>,
) -> Result<ObservationRead, ApiError> {
    core.read_observation(&session_id, after_sequence.unwrap_or(0))
}
#[tauri::command]
async fn hold_observation(
    core: tauri::State<'_, Core>,
    session_id: String,
) -> Result<ObservationHold, ApiError> {
    let core = core.inner().clone();
    worker(move || core.hold_observation(&session_id)).await
}
#[tauri::command]
async fn release_observation_hold(
    core: tauri::State<'_, Core>,
    session_id: String,
    hold_id: String,
) -> Result<(), ApiError> {
    core.release_observation_hold(&session_id, &hold_id)
}

#[tauri::command]
async fn configure_project_logs(
    core: tauri::State<'_, Core>,
    session_id: String,
    project: String,
    handles: Option<Vec<String>>,
) -> Result<ProjectLogPage, ApiError> {
    let core = core.inner().clone();
    worker(move || core.configure_project_logs(&session_id, &project, handles)).await
}
#[tauri::command]
async fn query_project_logs(
    core: tauri::State<'_, Core>,
    session_id: String,
    query: ProjectLogQuery,
) -> Result<ProjectLogPage, ApiError> {
    let core = core.inner().clone();
    worker(move || core.query_project_logs(&session_id, &query)).await
}
#[tauri::command]
async fn retry_project_logs(
    core: tauri::State<'_, Core>,
    session_id: String,
) -> Result<ProjectLogPage, ApiError> {
    let core = core.inner().clone();
    worker(move || core.retry_project_logs(&session_id)).await
}
#[tauri::command]
async fn stop_project_logs(
    core: tauri::State<'_, Core>,
    session_id: String,
) -> Result<(), ApiError> {
    let core = core.inner().clone();
    worker(move || core.stop_project_logs(&session_id)).await
}

#[tauri::command]
async fn retry_observation_events(
    core: tauri::State<'_, Core>,
    session_id: String,
) -> Result<ObservationRead, ApiError> {
    let core = core.inner().clone();
    worker(move || core.retry_observation_events(&session_id)).await
}

#[tauri::command]
async fn list_compose_projects(
    core: tauri::State<'_, Core>,
) -> Result<Vec<ComposeProject>, ApiError> {
    let core = core.inner().clone();
    worker(move || core.list_compose_projects()).await
}

#[tauri::command]
async fn preview_compose_project(
    core: tauri::State<'_, Core>,
    session_id: String,
    input: ComposeProjectInput,
) -> Result<ComposeProjectPreview, ApiError> {
    let core = core.inner().clone();
    worker(move || core.preview_compose_project(&session_id, input)).await
}

#[tauri::command]
async fn save_compose_project(
    core: tauri::State<'_, Core>,
    preview_id: String,
) -> Result<ComposeProject, ApiError> {
    let core = core.inner().clone();
    worker(move || core.save_compose_project(&preview_id)).await
}

#[tauri::command]
async fn remove_compose_project(
    core: tauri::State<'_, Core>,
    project_id: String,
    expected_revision: u64,
) -> Result<(), ApiError> {
    let core = core.inner().clone();
    worker(move || core.remove_compose_project(&project_id, expected_revision)).await
}

#[tauri::command]
async fn prepare_compose_operation(
    core: tauri::State<'_, Core>,
    session_id: String,
    project_id: String,
    expected_revision: u64,
    action: ComposeAction,
) -> Result<ComposeOperationPreview, ApiError> {
    let core = core.inner().clone();
    worker(move || {
        core.prepare_compose_operation(&session_id, &project_id, expected_revision, action)
    })
    .await
}

#[tauri::command]
async fn start_compose_operation(
    core: tauri::State<'_, Core>,
    session_id: String,
    prepare_id: String,
    request_id: String,
) -> Result<ComposeOperation, ApiError> {
    let core = core.inner().clone();
    worker(move || core.start_compose_operation(&session_id, &prepare_id, &request_id)).await
}

#[tauri::command]
async fn list_compose_operations(
    core: tauri::State<'_, Core>,
    session_id: String,
) -> Result<Vec<ComposeOperation>, ApiError> {
    let core = core.inner().clone();
    worker(move || core.list_compose_operations(&session_id)).await
}

#[tauri::command]
async fn read_compose_operation(
    core: tauri::State<'_, Core>,
    session_id: String,
    operation_id: String,
    after_sequence: u64,
) -> Result<ComposeOperationRead, ApiError> {
    let core = core.inner().clone();
    worker(move || core.read_compose_operation(&session_id, &operation_id, after_sequence)).await
}

#[tauri::command]
async fn cancel_compose_operation(
    core: tauri::State<'_, Core>,
    session_id: String,
    operation_id: String,
) -> Result<ComposeOperation, ApiError> {
    let core = core.inner().clone();
    worker(move || core.cancel_compose_operation(&session_id, &operation_id)).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Core::default())
        .setup(|app| {
            let path = app
                .path()
                .app_config_dir()?
                .join("compose-projects.v1.json");
            app.state::<Core>()
                .set_compose_storage_path(path)
                .map_err(|error| std::io::Error::other(error.message))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_environment,
            list_containers,
            get_recent_logs,
            get_container_details,
            get_container_stats,
            start_log_stream,
            read_log_stream,
            stop_log_stream,
            mutate_container,
            mutate_containers,
            configure_observation,
            read_observation,
            hold_observation,
            release_observation_hold,
            retry_observation_events,
            configure_project_logs,
            query_project_logs,
            retry_project_logs,
            stop_project_logs,
            pick_compose_path,
            list_compose_projects,
            preview_compose_project,
            save_compose_project,
            remove_compose_project,
            prepare_compose_operation,
            start_compose_operation,
            list_compose_operations,
            read_compose_operation,
            cancel_compose_operation,
        ])
        .build(tauri::generate_context!())
        .expect("Docker2U could not start")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                app.state::<Core>().shutdown();
            }
        });
}

#[cfg(test)]
mod ipc_tests {
    #[test]
    fn capability_exposes_only_typed_operations() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!([
                "allow-get-environment",
                "allow-list-containers",
                "allow-get-recent-logs",
                "allow-get-container-details",
                "allow-get-container-stats",
                "allow-start-log-stream",
                "allow-read-log-stream",
                "allow-stop-log-stream",
                "allow-mutate-container",
                "allow-mutate-containers",
                "allow-configure-observation",
                "allow-read-observation",
                "allow-hold-observation",
                "allow-release-observation-hold",
                "allow-retry-observation-events",
                "allow-configure-project-logs",
                "allow-query-project-logs",
                "allow-retry-project-logs",
                "allow-stop-project-logs",
                "allow-pick-compose-path",
                "allow-list-compose-projects",
                "allow-preview-compose-project",
                "allow-save-compose-project",
                "allow-remove-compose-project",
                "allow-prepare-compose-operation",
                "allow-start-compose-operation",
                "allow-list-compose-operations",
                "allow-read-compose-operation",
                "allow-cancel-compose-operation"
            ])
        );
    }
}
