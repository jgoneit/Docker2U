mod docker;
mod process;
#[cfg(all(test, unix))]
mod process_tests;

use docker::{Action, ApiError, BulkMutation, ContainerList, Core, Environment, Logs, Mutation};
use tauri::Manager;

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

pub fn run() {
    tauri::Builder::default()
        .manage(Core::default())
        .invoke_handler(tauri::generate_handler![
            get_environment,
            list_containers,
            get_recent_logs,
            mutate_container,
            mutate_containers
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
                "allow-mutate-container",
                "allow-mutate-containers"
            ])
        );
    }
}
