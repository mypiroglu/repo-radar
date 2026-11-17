mod git;

use std::path::PathBuf;

use git::RepoStatus;

#[tauri::command]
fn git_available() -> bool {
    git::git_available()
}

#[tauri::command]
fn default_roots() -> Vec<String> {
    git::default_roots()
}

#[tauri::command(async)]
fn scan(roots: Vec<String>, max_depth: u32) -> Vec<RepoStatus> {
    git::scan(&roots, max_depth.clamp(1, 8))
}

#[tauri::command(async)]
fn refresh_repo(path: String) -> RepoStatus {
    git::repo_status(&PathBuf::from(path))
}

#[tauri::command(async)]
fn fetch_repo(path: String) -> Result<RepoStatus, String> {
    git::fetch(&PathBuf::from(path))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            git_available,
            default_roots,
            scan,
            refresh_repo,
            fetch_repo
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
