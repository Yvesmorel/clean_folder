#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Clone, Default, PartialEq)]
struct ShortcutPair { visibility: Option<Shortcut>, quick: Option<Shortcut> }
impl ShortcutPair {
    fn values(&self) -> Vec<Shortcut> { [self.visibility, self.quick].into_iter().flatten().collect() }
}
#[derive(Default)]
struct ApplicationShortcuts(Mutex<ShortcutPair>);

fn parse_shortcut(value: &str) -> Result<Option<Shortcut>, String> {
    if value.is_empty() { return Ok(None); }
    value.parse::<Shortcut>().map(Some).map_err(|_| "Choose a valid shortcut.".to_string())
}
// Reuse already registered keys (including swaps) and roll back a failed change.
fn replace_shortcuts(
    current: &ShortcutPair, next: &ShortcutPair,
    mut register: impl FnMut(Shortcut) -> Result<(), String>,
    mut unregister: impl FnMut(Shortcut) -> Result<(), String>,
) -> Result<(), String> {
    if next.visibility.is_some() && next.visibility == next.quick {
        return Err("Choose different shortcuts.".to_string());
    }
    let old = current.values(); let new = next.values();
    let mut added = Vec::new(); let mut removed = Vec::new();
    for value in new.iter().filter(|value| !old.contains(value)) {
        if let Err(error) = register(*value) {
            for added in added { let _ = unregister(added); }
            return Err(format!("This shortcut is unavailable. Choose another combination. {error}"));
        }
        added.push(*value);
    }
    for value in old.iter().filter(|value| !new.contains(value)) {
        if let Err(error) = unregister(*value) {
            for added in added { let _ = unregister(added); }
            for removed in removed { let _ = register(removed); }
            return Err(format!("Could not replace the shortcuts: {error}"));
        }
        removed.push(*value);
    }
    Ok(())
}
#[tauri::command]
fn set_application_shortcuts(
    app: tauri::AppHandle, window: tauri::WebviewWindow, visibility: String, quick: String,
    state: tauri::State<ApplicationShortcuts>,
) -> Result<(), String> {
    if window.label() != "main" { return Err("Set shortcuts in the main window.".to_string()); }
    let next = ShortcutPair { visibility: parse_shortcut(&visibility)?, quick: parse_shortcut(&quick)? };
    let mut current = state.0.lock().map_err(|_| "Shortcuts are unavailable.".to_string())?;
    replace_shortcuts(&current, &next,
        |value| app.global_shortcut().register(value).map_err(|error| error.to_string()),
        |value| app.global_shortcut().unregister(value).map_err(|error| error.to_string()))?;
    *current = next; Ok(())
}
fn reveal(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let window = app.get_webview_window(label).ok_or("Window unavailable.")?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}
#[tauri::command]
fn open_quick_access(app: tauri::AppHandle) -> Result<(), String> { reveal(&app, "quick") }
#[tauri::command]
fn hide_quick_access(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("quick").ok_or("Window unavailable.")?.hide().map_err(|error| error.to_string())
}
#[tauri::command]
fn open_main_workspace(app: tauri::AppHandle) -> Result<(), String> { reveal(&app, "main") }

fn main() {
    tauri::Builder::default()
        .manage(ApplicationShortcuts::default())
        .invoke_handler(tauri::generate_handler![set_application_shortcuts, open_quick_access, hide_quick_access, open_main_workspace])
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| { let _ = reveal(app, "main"); }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed { return; }
            let state = app.state::<ApplicationShortcuts>();
            let action = state.0.try_lock().ok().and_then(|pair| {
                if pair.quick.as_ref() == Some(shortcut) { Some("quick") }
                else if pair.visibility.as_ref() == Some(shortcut) { Some("main") }
                else { None }
            });
            let Some(label) = action else { return; };
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if label == "quick" { let _ = reveal(&handle, label); }
                else if let Some(window) = handle.get_webview_window(label) {
                    if window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false) { let _ = window.hide(); }
                    else { let _ = reveal(&handle, label); }
                }
            });
        }).build())
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) { window.app_handle().exit(0); }
            if window.label() == "quick" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close(); let _ = window.hide();
                }
            }
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("Clean_folder could not start");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    fn pair(visibility: &str, quick: &str) -> ShortcutPair {
        ShortcutPair { visibility: parse_shortcut(visibility).unwrap(), quick: parse_shortcut(quick).unwrap() }
    }
    #[test]
    fn swaps_reuse_registered_keys() {
        replace_shortcuts(&pair("Control+Alt+K", "Control+Alt+Space"), &pair("Control+Alt+Space", "Control+Alt+K"),
            |_| panic!("Keys must be reused"), |_| panic!("Keys must be reused")).unwrap();
    }
    #[test]
    fn conflict_rolls_back_added_keys_and_keeps_existing_keys() {
        let current = pair("Control+Alt+K", "Control+Alt+Space");
        let next = pair("Control+Alt+J", "Control+Alt+L");
        let held = RefCell::new(current.values()); let conflict = next.quick.unwrap();
        let result = replace_shortcuts(&current, &next, |value| {
            if value == conflict { return Err("Already used".into()); }
            held.borrow_mut().push(value); Ok(())
        }, |value| { held.borrow_mut().retain(|key| *key != value); Ok(()) });
        assert!(result.is_err()); assert_eq!(*held.borrow(), current.values());
    }
    #[test]
    fn duplicate_shortcuts_are_rejected() {
        assert!(replace_shortcuts(&ShortcutPair::default(), &pair("Control+Alt+K", "Alt+Control+K"), |_| Ok(()), |_| Ok(())).is_err());
    }
}
