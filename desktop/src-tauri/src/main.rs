#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Menu-bar shell for the local Meshrooms node. The daemon stays the single owner of rooms
//! (docs/architecture/0001-one-daemon-many-rooms.md): quitting the shell leaves it running,
//! and the room window is the daemon's own loopback UI, which receives no Tauri IPC.

mod runtime;

use runtime::Runtime;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};

struct Shell {
    runtime: Mutex<Option<Arc<Runtime>>>,
    running: AtomicBool,
    status: MenuItem<Wry>,
}

fn runtime(app: &AppHandle) -> Result<Arc<Runtime>, String> {
    let shell = app.state::<Shell>();
    let mut slot = shell.runtime.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(runtime) = slot.as_ref() {
        return Ok(runtime.clone());
    }
    let bundled = app.path().resource_dir().ok().map(|dir| dir.join("runtime"));
    let runtime = Arc::new(runtime::resolve(bundled)?);
    *slot = Some(runtime.clone());
    Ok(runtime)
}

fn report(app: &AppHandle, running: bool, text: &str) {
    let shell = app.state::<Shell>();
    shell.running.store(running, Ordering::Relaxed);
    let _ = shell.status.set_text(text);
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("Meshrooms: {text}")));
    }
}

fn refresh(app: &AppHandle) {
    match runtime(app).and_then(|runtime| runtime::cli(&runtime, &["status"])) {
        Ok(status) => match status["runtime"]["url"].as_str().and_then(|url| Url::parse(url).ok()) {
            Some(url) => report(app, true, &format!("Node running on port {}", url.port().unwrap_or_default())),
            None => report(app, false, "Node not running"),
        },
        Err(error) => report(app, false, &error),
    }
}

/// `open` starts or reuses the node and returns its loopback URL with a one-time ticket.
fn open_link(app: &AppHandle) -> Result<Url, String> {
    let result: Value = runtime::cli(&*runtime(app)?, &["open"])?;
    result["url"].as_str().and_then(|url| Url::parse(url).ok()).ok_or_else(|| "The node returned no room link.".into())
}

/// Where the bundled status page is served: the CLI's dev server in development, else the app protocol.
fn app_origin(app: &AppHandle) -> Url {
    #[cfg(debug_assertions)]
    if let Some(url) = app.config().build.dev_url.clone() {
        return url;
    }
    let _ = app;
    Url::parse(if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" }).expect("static URL")
}

/// The bundled status page. Progress and errors are passed in the query, never evaluated in a page.
fn page(app: &AppHandle, title: &str, detail: &str, failed: bool) -> Url {
    let mut url = app_origin(app).join("index.html").expect("static path");
    url.query_pairs_mut().append_pair("title", title).append_pair("detail", detail).append_pair("failed", if failed { "1" } else { "0" });
    url
}

fn on_node(app: &AppHandle, window: &WebviewWindow) -> bool {
    window.url().map(|url| url.origin() != app_origin(app).origin()).unwrap_or(false)
}

fn connect(app: &AppHandle, window: &WebviewWindow) {
    if on_node(app, window) {
        let _ = window.navigate(page(app, "Reconnecting", "Starting or reusing this machine's node.", false));
    }
    match open_link(app) {
        Ok(url) => {
            let _ = window.navigate(url);
            refresh(app);
        }
        Err(error) => {
            let _ = window.navigate(page(app, "Meshrooms could not start", &error, true));
            report(app, false, "Node not running");
        }
    }
}

fn show_room(app: &AppHandle) {
    let window = match app.get_webview_window("room") {
        Some(window) => window,
        None => match WebviewWindowBuilder::new(app, "room", WebviewUrl::App("index.html".into()))
            .title("Meshrooms")
            .inner_size(1180.0, 800.0)
            .min_inner_size(720.0, 520.0)
            .build()
        {
            Ok(window) => window,
            Err(error) => return eprintln!("Cannot open the Meshrooms window: {error}"),
        },
    };
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let _ = window.show();
    let _ = window.set_focus();
    // A live room view keeps its session cookie; only reconnect when it is not showing the node.
    if on_node(app, &window) && app.state::<Shell>().running.load(Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || connect(&app, &window));
}

fn open_in_browser(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || match open_link(&app) {
        Ok(url) => {
            let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
        }
        Err(error) => report(&app, false, &error),
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_room(app)))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let status = MenuItem::with_id(app, "status", "Checking node…", false, None::<&str>)?;
            let menu = Menu::with_items(app, &[
                &status,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "open", "Open Meshrooms", true, None::<&str>)?,
                &MenuItem::with_id(app, "browser", "Open in Browser", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "quit", "Quit (rooms keep running)", true, None::<&str>)?,
            ])?;
            app.manage(Shell { runtime: Mutex::new(None), running: AtomicBool::new(false), status });
            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Meshrooms")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_room(app),
                    "browser" => open_in_browser(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            show_room(app.handle());
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                refresh(&handle);
                thread::sleep(Duration::from_secs(15));
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                #[cfg(target_os = "macos")]
                let _ = window.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        })
        .run(tauri::generate_context!())
        .expect("Meshrooms desktop shell failed to start");
}
