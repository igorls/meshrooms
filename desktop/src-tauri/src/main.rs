#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tray app that keeps this machine's agent daemon running (internal/docs/design/machine-daemon.md, "Lifecycle: one
//! owner"). The app never runs the daemon itself: it drives the bridge's own CLI, and the daemon's lock stays the one
//! owner. The app's login item starts the app; the app starts the daemon whenever it isn't running, unless the person
//! stopped it from the tray. Quitting the app leaves the daemon running.

mod approvals;
mod bridge;
mod join;
mod links;
mod pair;
mod login;
mod notify;
mod review;
mod runtime;
mod text;

use bridge::Bridge;
use login::LoginState;
use serde_json::Value;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};

const POLL: Duration = Duration::from_secs(10);
/// After an automatic start fails, the next one waits this long instead of retrying at every poll.
const START_BACKOFF: Duration = Duration::from_secs(60);
/// How long an error from an action stays on the status line before polls may replace it.
const NOTICE_FOR: Duration = Duration::from_secs(60);
/// Started by the login item: tray only, no window and no activation.
const BACKGROUND: &str = "--background";
/// The app starts the daemon with its approval routes on, which only the Approvals window uses (approvals.rs).
const DAEMON_START: [&str; 3] = ["daemon", "start", "--approvals"];

struct Shell {
    bridge: Mutex<Option<Arc<Bridge>>>,
    /// The person stopped the daemon from the tray: it is not started again until they start it.
    held: AtomicBool,
    /// Daemon actions and polls run one at a time.
    work: Mutex<()>,
    failed_start: Mutex<Option<Instant>>,
    /// The last error from an action or an automatic start, kept on the status line for `NOTICE_FOR`.
    notice: Mutex<Option<(Instant, String)>>,
    log_dir: Mutex<Option<PathBuf>>,
    rooms_shown: Mutex<Vec<String>>,
    detail: Mutex<String>,
    status: MenuItem<Wry>,
    rooms: Submenu<Wry>,
    /// "Approvals…", with the count of what waits, and the count it last showed.
    approvals: MenuItem<Wry>,
    approvals_shown: Mutex<Option<u64>>,
    start: MenuItem<Wry>,
    stop: MenuItem<Wry>,
    login: CheckMenuItem<Wry>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn bridge(app: &AppHandle) -> Result<Arc<Bridge>, String> {
    let shell = app.state::<Shell>();
    let mut slot = lock(&shell.bridge);
    if let Some(bridge) = slot.as_ref() {
        return Ok(bridge.clone());
    }
    let bundled = app.path().resource_dir().ok().map(|dir| dir.join("bridge"));
    let bridge = Arc::new(bridge::resolve(bundled)?);
    *slot = Some(bridge.clone());
    Ok(bridge)
}

fn cli(app: &AppHandle, args: &[&str]) -> Result<Value, String> {
    bridge::cli(&*bridge(app)?, args)
}

/// Keeps `error` on the status line for a minute, so the next poll doesn't hide it.
fn notify(app: &AppHandle, error: &str) {
    *lock(&app.state::<Shell>().notice) = Some((Instant::now(), text::clean(error, 120)));
}

/// The status line, the tooltip, the Start/Stop items and, when it is open, the window. A recent error stays shown.
fn report(app: &AppHandle, running: Option<bool>, line: &str) {
    let shell = app.state::<Shell>();
    let notice = lock(&shell.notice).as_ref().filter(|(at, _)| at.elapsed() < NOTICE_FOR).map(|(_, notice)| notice.clone());
    let line = notice.as_deref().unwrap_or(line);
    #[cfg(debug_assertions)]
    eprintln!("tray status: {} (running: {running:?})", text::clean(line, 120));
    let _ = shell.status.set_text(text::label(line, 90));
    // Unknown (an error) leaves Start and Stop as the last poll set them.
    if let Some(running) = running {
        let _ = shell.start.set_enabled(!running);
        let _ = shell.stop.set_enabled(running);
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("Meshrooms: {}", text::clean(line, 100))));
    }
    let mut detail = lock(&shell.detail);
    if *detail != line {
        *detail = line.to_string();
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.navigate(page(app, line));
        }
    }
}

/// One room per row of `bindings --json`: a submenu titled with the room and its wake state, holding the details.
fn room_rows(list: &Value) -> Vec<(String, Vec<String>)> {
    let rows = list["bindings"].as_array().cloned().unwrap_or_default();
    rows.iter()
        .map(|row| {
            let field = |name: &str| row[name].as_str().map(|value| text::clean(value, 60)).filter(|value| !value.is_empty());
            let state = if row["closed"].is_string() {
                "closed".to_string()
            } else if row["retired"].is_string() {
                "retired".to_string()
            } else {
                row["wakes"]["state"].as_str().map(|state| text::clean(state, 16)).unwrap_or_else(|| "unknown".into())
            };
            let title = field("title").unwrap_or_else(|| "Untitled room".into());
            let mut details = Vec::new();
            if let Some(agent) = field("agent") {
                details.push(format!("Agent: {agent}"));
            }
            match row["wakes"]["reason"].as_str().map(|reason| text::clean(reason, 80)).filter(|reason| !reason.is_empty()) {
                Some(reason) => details.push(format!("Wakes: {state} ({reason})")),
                None => details.push(format!("Wakes: {state}")),
            }
            details.push(format!("Last wake: {}", row["lastWake"].as_str().map(text::when).unwrap_or_else(|| "never".into())));
            if let Some(harness) = field("harness") {
                details.push(format!("Harness: {harness}"));
            }
            (format!("{title}: {state}"), details)
        })
        .collect()
}

fn show_rooms(app: &AppHandle, rows: Result<Vec<(String, Vec<String>)>, String>) {
    let shell = app.state::<Shell>();
    let rows = rows.unwrap_or_else(|error| vec![(format!("Rooms unavailable: {}", text::clean(&error, 70)), Vec::new())]);
    let rows = if rows.is_empty() { vec![("No agents on this machine yet".to_string(), Vec::new())] } else { rows };
    let signature: Vec<String> = rows.iter().map(|(title, details)| format!("{title}\n{}", details.join("\n"))).collect();
    let mut shown = lock(&shell.rooms_shown);
    if *shown == signature {
        return;
    }
    #[cfg(debug_assertions)]
    eprintln!("tray rooms: {signature:?}");
    let menu = &shell.rooms;
    for item in menu.items().unwrap_or_default() {
        let _ = menu.remove(&item);
    }
    for (title, details) in &rows {
        let label = text::label(title, 70);
        let added = if details.is_empty() {
            MenuItem::new(app, label, false, None::<&str>).and_then(|item| menu.append(&item))
        } else {
            let items: Vec<MenuItem<Wry>> = details.iter().filter_map(|line| MenuItem::new(app, text::label(line, 100), false, None::<&str>).ok()).collect();
            let refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = items.iter().map(|item| item as &dyn tauri::menu::IsMenuItem<Wry>).collect();
            Submenu::with_items(app, label, true, &refs).and_then(|submenu| menu.append(&submenu))
        };
        if added.is_err() {
            return;
        }
    }
    *shown = signature;
}

fn app_exe() -> Result<PathBuf, String> {
    env::current_exe().map_err(|error| format!("Cannot locate the Meshrooms app: {error}"))
}

fn show_login(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let state = app_exe().and_then(|exe| login::state(&exe));
    let (checked, enabled, label) = match state {
        Ok(LoginState::App) => (true, true, "Start at login".to_string()),
        Ok(LoginState::Headless) => (false, true, "Start at login (now the daemon starts on its own)".to_string()),
        Ok(LoginState::Off) => (false, true, "Start at login".to_string()),
        Err(error) => (false, false, format!("Start at login: {}", text::clean(&error, 60))),
    };
    #[cfg(debug_assertions)]
    eprintln!("tray login: {label} (checked: {checked}, enabled: {enabled})");
    let _ = shell.login.set_checked(checked);
    let _ = shell.login.set_enabled(enabled);
    let _ = shell.login.set_text(text::label(&label, 90));
}

/// One poll: starts the daemon when it should run, then shows its status, the rooms and the login item. Callers hold `work`.
fn refresh_locked(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let mut status = cli(app, &["daemon", "status"]);
    let stopped = matches!(&status, Ok(status) if status["running"] != Value::Bool(true));
    let waiting = lock(&shell.failed_start).is_some_and(|at| at.elapsed() < START_BACKOFF);
    if stopped && !shell.held.load(Ordering::Relaxed) && !waiting {
        report(app, Some(false), "Starting the daemon…");
        match cli(app, &DAEMON_START) {
            Ok(_) => {
                *lock(&shell.failed_start) = None;
                status = cli(app, &["daemon", "status"]);
            }
            Err(error) => {
                *lock(&shell.failed_start) = Some(Instant::now());
                notify(app, &format!("The daemon did not start: {error}"));
                status = cli(app, &["daemon", "status"]);
            }
        }
    }
    match &status {
        Ok(status) => {
            // What waits for the person's approval: `daemon status` counts it, with no command of its own.
            if let Some(waiting) = status["approvalsWaiting"].as_u64() {
                show_approvals(app, waiting);
            }
            if let Some(dir) = status["log"].as_str().map(Path::new).and_then(Path::parent).filter(|dir| dir.is_absolute()) {
                *lock(&shell.log_dir) = Some(dir.to_path_buf());
            }
            if status["running"] == Value::Bool(true) {
                let version = status["version"].as_str().map(|version| format!(" (bridge {})", text::clean(version, 24))).unwrap_or_default();
                report(app, Some(true), &format!("Daemon running{version}"));
            } else if shell.held.load(Ordering::Relaxed) {
                report(app, Some(false), "Daemon stopped from the tray");
            } else {
                report(app, Some(false), "Daemon not running");
            }
        }
        Err(error) => report(app, None, &text::clean(error, 120)),
    }
    show_rooms(app, cli(app, &["bindings", "--json"]).map(|list| room_rows(&list)));
    show_login(app);
}

/// The tray's "Approvals…" item, with the count of requests waiting.
fn show_approvals(app: &AppHandle, waiting: u64) {
    let shell = app.state::<Shell>();
    let mut shown = lock(&shell.approvals_shown);
    if *shown == Some(waiting) {
        return;
    }
    #[cfg(debug_assertions)]
    eprintln!("tray approvals: {waiting} waiting");
    if shell.approvals.set_text(approvals::tray_label(waiting)).is_ok() {
        *shown = Some(waiting);
    }
}

/// Runs `action` off the main thread, after any poll or action in progress, then refreshes.
fn act(app: &AppHandle, action: impl FnOnce(&AppHandle) -> Result<(), String> + Send + 'static) {
    let app = app.clone();
    thread::spawn(move || {
        let shell = app.state::<Shell>();
        let _turn = lock(&shell.work);
        *lock(&shell.notice) = None;
        if let Err(error) = action(&app) {
            notify(&app, &error);
        }
        refresh_locked(&app);
    });
}

fn start_daemon(app: &AppHandle) {
    app.state::<Shell>().held.store(false, Ordering::Relaxed);
    *lock(&app.state::<Shell>().failed_start) = None;
    act(app, |app| cli(app, &DAEMON_START).map(drop));
}

fn stop_daemon(app: &AppHandle) {
    // Held first, so a poll between now and the stop can't start it again.
    app.state::<Shell>().held.store(true, Ordering::Relaxed);
    act(app, |app| {
        let result = cli(app, &["daemon", "stop"]);
        // Held only while the daemon really is down; otherwise polls keep it running as before.
        let down = result.as_ref().is_ok_and(|result| result["stopped"] == Value::Bool(true) || result["running"] == Value::Bool(false));
        if !down {
            app.state::<Shell>().held.store(false, Ordering::Relaxed);
        }
        let result = result?;
        match result["reason"].as_str() {
            _ if down => Ok(()),
            Some(reason) => Err(format!("The daemon was not stopped: {reason}")),
            None => Err("The daemon was not stopped.".into()),
        }
    });
}

/// On: register the app's login item, then remove the bridge's own (`daemon uninstall`). If registering fails, nothing
/// is removed; if removing fails, `login::state` still reports Headless and the move is offered again. Off: remove the
/// app's.
fn toggle_login(app: &AppHandle) {
    act(app, |app| {
        let exe = app_exe()?;
        let result = match login::state(&exe)? {
            LoginState::App => login::disable(),
            LoginState::Headless | LoginState::Off => login::enable(&exe).and_then(|()| cli(app, &["daemon", "uninstall"]).map(drop)),
        };
        result.map_err(|error| format!("Start at login: {error}"))
    });
}

/// `person open`: a one-time sign-in link to the local UI, which the daemon serves on 127.0.0.1, opened in the default
/// browser. The link carries a ticket, so only that address is ever opened.
fn open_meshrooms(app: &AppHandle) {
    open_meshrooms_at(app, None);
}

/// `person open [--room <room>]`: the local UI, at a room of the person's when `room` is given (a join link's room).
fn open_meshrooms_at(app: &AppHandle, room: Option<String>) {
    open_meshrooms_then(app, room, |_| {});
}

/// `open_meshrooms_at`, then `after` once the open is done or failed.
fn open_meshrooms_then(app: &AppHandle, room: Option<String>, after: impl FnOnce(&AppHandle) + Send + 'static) {
    act(app, move |app| {
        let opened = (|| {
            let result = match &room {
                Some(room) => cli(app, &["person", "open", "--room", room])?,
                None => cli(app, &["person", "open"])?,
            };
            let link = local_link(result["url"].as_str().ok_or("Meshrooms gave no link to open.")?, room.as_deref())?;
            open_external(link.as_str()).map_err(|error| format!("Cannot open Meshrooms in the browser: {error}"))
        })();
        after(app);
        opened
    });
}

/// The bridge's sign-in link, only if it is this computer's local UI (plain HTTP on 127.0.0.1) at the page asked for:
/// the rooms, or exactly the room `room`.
fn local_link(link: &str, room: Option<&str>) -> Result<Url, String> {
    let url = Url::parse(link).map_err(|_| "Meshrooms gave a link that is not an address.".to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
        return Err("Meshrooms gave a link to somewhere other than this computer, so it was not opened.".into());
    }
    let wanted = room.map(|room| format!("/r/{room}")).unwrap_or_else(|| "/".into());
    if url.path() != wanted {
        return Err("Meshrooms gave a link to another page than the one asked for, so it was not opened.".into());
    }
    Ok(url)
}

/// Opens an address in the default browser. Development builds with `MESHROOMS_DEV_OPENED=<file>` append it to that file
/// instead, so checks can follow the link without a browser on the desktop. Never in a release.
fn open_external(url: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if let Some(file) = env::var_os("MESHROOMS_DEV_OPENED") {
        use std::io::Write;
        let mut out = std::fs::OpenOptions::new().create(true).append(true).open(file).map_err(|error| error.to_string())?;
        return writeln!(out, "{url}").map_err(|error| error.to_string());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|error| error.to_string())
}

fn open_logs(app: &AppHandle) {
    let dir = lock(&app.state::<Shell>().log_dir).clone().or_else(|| runtime::home().ok().map(|home| home.join(".meshrooms").join("daemon")));
    match dir.filter(|dir| dir.is_dir()) {
        Some(dir) => {
            if let Err(error) = tauri_plugin_opener::open_path(&dir, None::<&str>) {
                notify(app, &format!("Cannot open the logs folder: {error}"));
                report(app, None, "");
            }
        }
        None => {
            notify(app, "The daemon has no logs yet.");
            report(app, None, "");
        }
    }
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

/// The bundled status page. The status is passed in the query, never evaluated in a page.
fn page(app: &AppHandle, detail: &str) -> Url {
    let mut url = app_origin(app).join("index.html").expect("static path");
    url.query_pairs_mut().append_pair("detail", &text::clean(detail, 120));
    url
}

fn show_window(app: &AppHandle) {
    let detail = lock(&app.state::<Shell>().detail).clone();
    let window = match app.get_webview_window("main") {
        Some(window) => window,
        None => match WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title("Meshrooms")
            .inner_size(440.0, 300.0)
            .resizable(false)
            .build()
        {
            Ok(window) => {
                let _ = window.navigate(page(app, &detail));
                window
            }
            Err(error) => return eprintln!("Cannot open the Meshrooms window: {error}"),
        },
    };
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let _ = window.show();
    let _ = window.set_focus();
}

/// macOS: once `closing` goes and no other window is visible, the app is a tray app again, with no Dock icon left behind.
fn tray_only(closing: &tauri::Window) {
    #[cfg(target_os = "macos")]
    {
        let app = closing.app_handle();
        let others = app.webview_windows().into_values().any(|window| window.label() != closing.label() && window.is_visible().unwrap_or(false));
        if !others {
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = closing;
}

fn menu_action(app: &AppHandle, id: &str) {
    match id {
        "start" => start_daemon(app),
        "stop" => stop_daemon(app),
        "login" => toggle_login(app),
        "open" => open_meshrooms(app),
        "window" => show_window(app),
        "logs" => open_logs(app),
        "unpair" => pair::ask_unpair(app),
        "review" => review::show(app),
        "approvals" => approvals::show(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

fn main() {
    let background = env::args().any(|arg| arg == BACKGROUND);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Development builds: `--dev-action=<menu id>` from a second launch runs that tray item, for checks without a mouse.
            #[cfg(debug_assertions)]
            if let Some(id) = args.iter().find_map(|arg| arg.strip_prefix("--dev-action=")) {
                return menu_action(app, id);
            }
            // Development builds: `--dev-pair-phrase=<words>` types the phrase into the pairing window and presses Next,
            // `--dev-pair-confirm` presses the final Pair, `--dev-pair-reject` presses Reject, and `--dev-unpair-confirm`
            // presses Unpair; `--dev-join-confirm`, `--dev-join-browse` and `--dev-join-cancel` press the join window's
            // Join, Open in browser and Cancel, and `--dev-join-view` prints what that window shows; the
            // `--dev-approvals-*` flags press the Approvals window's Approve, Reject and Make this agent, and print what it
            // shows: checks of the native windows without a mouse, through the same code. Never in a release.
            #[cfg(debug_assertions)]
            {
                let result = if let Some(typed) = args.iter().find_map(|arg| arg.strip_prefix("--dev-pair-phrase=")) {
                    Some(pair::verify_typed(app, typed))
                } else if args.iter().any(|arg| arg == "--dev-pair-confirm") {
                    Some(pair::confirm(app))
                } else if args.iter().any(|arg| arg == "--dev-unpair-confirm") {
                    Some(pair::unpair(app))
                } else if args.iter().any(|arg| arg == "--dev-pair-reject") {
                    pair::closed(app);
                    Some(Ok(()))
                } else if args.iter().any(|arg| arg == "--dev-join-confirm") {
                    Some(join::confirm(app, None))
                } else if args.iter().any(|arg| arg == "--dev-join-browse") {
                    Some(join::browse(app))
                } else if args.iter().any(|arg| arg == "--dev-join-cancel") {
                    join::closed(app);
                    if let Some(window) = app.get_webview_window(join::WINDOW) {
                        let _ = window.close();
                    }
                    Some(Ok(()))
                } else if args.iter().any(|arg| arg == "--dev-join-view") {
                    eprintln!("join view: {}", lock(app.state::<Mutex<join::Joining>>().inner()).view(Instant::now()));
                    Some(Ok(()))
                } else if let Some(which) = args.iter().find_map(|arg| arg.strip_prefix("--dev-notify-click=")) {
                    // Clicks a posted notification (`last`, or its index), through the same code as a real click.
                    Some(notify::dev_click(app, which))
                } else if args.iter().any(|arg| arg == "--dev-notify-real") {
                    // Posts the last notification again as a real one (one toast on the desktop).
                    Some(notify::dev_real(app))
                } else if let Some(index) = args.iter().find_map(|arg| arg.strip_prefix("--dev-review-pause=")) {
                    Some(review::dev_change(app, index, false, false))
                } else if let Some(index) = args.iter().find_map(|arg| arg.strip_prefix("--dev-review-resume=")) {
                    Some(review::dev_change(app, index, true, false))
                } else if let Some(index) = args.iter().find_map(|arg| arg.strip_prefix("--dev-review-resume-anyway=")) {
                    // Resume past the hold the list shows, as the confirm step's Resume anyway does.
                    Some(review::dev_change(app, index, true, true))
                } else if args.iter().any(|arg| arg == "--dev-review-view") {
                    eprintln!("review view: {}", review::dev_view(app));
                    Some(Ok(()))
                } else if let Some(which) = args.iter().find_map(|arg| arg.strip_prefix("--dev-approvals-approve=")) {
                    // Approve <id>:<digest>, the digest the window showed, as its Approve button sends it.
                    Some(approvals::dev_approve(app, which))
                } else if let Some(id) = args.iter().find_map(|arg| arg.strip_prefix("--dev-approvals-reject=")) {
                    Some(approvals::dev_reject(app, id))
                } else if let Some(file) = args.iter().find_map(|arg| arg.strip_prefix("--dev-approvals-custom-check=")) {
                    // The custom-command form, filled from a JSON file ({ name, command, model }), then Review.
                    Some(approvals::dev_custom_check(app, file))
                } else if args.iter().any(|arg| arg == "--dev-approvals-custom-make") {
                    // Make this agent, on the confirmation the window shows.
                    Some(approvals::dev_custom_make(app))
                } else if args.iter().any(|arg| arg == "--dev-approvals-view") {
                    eprintln!("approvals view: {}", approvals::dev_view(app));
                    Some(Ok(()))
                } else {
                    None
                };
                if let Some(result) = result {
                    if let Err(error) = result {
                        eprintln!("dev action: {error}");
                    }
                    return;
                }
            }
            // A deep link (forwarded to the deep-link plugin by this plugin's `deep-link` feature) shows its own window.
            if args.iter().any(|arg| arg.starts_with("meshrooms:")) {
                return;
            }
            if !args.iter().any(|arg| arg == BACKGROUND) {
                show_window(app);
            }
        }))
        // BEGIN M3 links: Windows/Linux forwarding also needs the owner's scheme config.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri::plugin::Builder::<Wry, ()>::new("meshrooms-links").setup(|app, _| {
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() { links::route(&handle, url.as_str()); }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls { links::route(app, url.as_str()); }
            }
            Ok(())
        }).build())
        // END M3 links. macOS cold/live delivery uses the plugin's RunEvent::Opened.
        .plugin(tauri_plugin_opener::init())
        // Posted from Rust only (notify.rs): no window's capability grants any of its commands.
        .plugin(tauri_plugin_notification::init())
        // The pairing window's commands (pair.rs), the join window's (join.rs), the Review window's (review.rs) and the
        // Approvals window's (approvals.rs); each answers only to its own window.
        .manage(Mutex::new(pair::Pairing::default()))
        .manage(Mutex::new(join::Joining::default()))
        .manage(Mutex::new(review::Reviewing::default()))
        .manage(Mutex::new(approvals::Approving::default()))
        .manage(Mutex::new(notify::Posted::default()))
        .invoke_handler(tauri::generate_handler![
            pair::pair_view, pair::pair_check, pair::pair_verify, pair::pair_confirm, pair::pair_reject, pair::pair_unpair, pair::pair_close, pair::pair_open,
            join::join_view, join::join_confirm, join::join_cancel, join::join_browse,
            review::review_view, review::review_pause, review::review_resume, review::review_close,
            approvals::approvals_view, approvals::approvals_approve, approvals::approvals_reject, approvals::approvals_custom_check, approvals::approvals_custom_make, approvals::approvals_custom_edit, approvals::approvals_close,
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let status = MenuItem::with_id(app, "status", "Checking the daemon…", false, None::<&str>)?;
            let rooms = Submenu::with_id(app, "rooms", "Rooms", true)?;
            let start = MenuItem::with_id(app, "start", "Start daemon", false, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop daemon", false, None::<&str>)?;
            let login = CheckMenuItem::with_id(app, "login", "Start at login", false, false, None::<&str>)?;
            let approvals_item = MenuItem::with_id(app, "approvals", approvals::tray_label(0), true, None::<&str>)?;
            let menu = Menu::with_items(app, &[
                &status,
                &rooms,
                &PredefinedMenuItem::separator(app)?,
                &start,
                &stop,
                &login,
                &MenuItem::with_id(app, "open", "Open Meshrooms", true, None::<&str>)?,
                &MenuItem::with_id(app, "window", "Show Meshrooms", true, None::<&str>)?,
                &MenuItem::with_id(app, "review", "Review your agents…", true, None::<&str>)?,
                &approvals_item,
                &MenuItem::with_id(app, "logs", "Open logs folder", true, None::<&str>)?,
                &MenuItem::with_id(app, "unpair", "Unpair this computer…", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "quit", "Quit (the daemon keeps running)", true, None::<&str>)?,
            ])?;
            app.manage(Shell {
                bridge: Mutex::new(None),
                held: AtomicBool::new(false),
                work: Mutex::new(()),
                failed_start: Mutex::new(None),
                notice: Mutex::new(None),
                log_dir: Mutex::new(None),
                rooms_shown: Mutex::new(Vec::new()),
                detail: Mutex::new("Checking the daemon…".into()),
                status,
                rooms,
                approvals: approvals_item,
                approvals_shown: Mutex::new(None),
                start,
                stop,
                login,
            });
            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Meshrooms")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| menu_action(app, event.id.as_ref()))
                .build(app)?;
            // Started by a deep link, the link's own window is what the person sees.
            if !background && !env::args().any(|arg| arg.starts_with("meshrooms:")) {
                show_window(app.handle());
            }
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                {
                    let shell = handle.state::<Shell>();
                    let _turn = lock(&shell.work);
                    refresh_locked(&handle);
                }
                thread::sleep(POLL);
            });
            // The notification feed, and the "agents live" notice on start and whenever the daemon comes back.
            notify::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing the pairing window rejects what waits in it: a hidden one would hold off every other pairing.
                if window.label() == pair::WINDOW {
                    pair::closed(window.app_handle());
                    tray_only(window);
                    return;
                }
                // Closing the join window ends the join: one not yet asked for is dropped, and one waiting for the host
                // stops being followed (its request stays with the room until it expires).
                if window.label() == join::WINDOW {
                    join::closed(window.app_handle());
                    tray_only(window);
                    return;
                }
                // Closing the Review window stops its refresher; it opens again from a notification or the tray.
                if window.label() == review::WINDOW {
                    review::closed(window.app_handle());
                    tray_only(window);
                    return;
                }
                // Closing the Approvals window stops its refresher; whatever waits stays waiting, for the next time.
                if window.label() == approvals::WINDOW {
                    approvals::closed(window.app_handle());
                    tray_only(window);
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
                #[cfg(target_os = "macos")]
                let _ = window.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        })
        .build(tauri::generate_context!())
        .expect("Meshrooms desktop app failed to start")
        .run(|_app, event| {
            // A tray app: closing its last window (a pairing or join window, when nothing else is open) must not quit it.
            // Only Quit (app.exit, with a code) does.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_this_computers_local_ui_at_the_page_asked_for_is_opened() {
        const ROOM: &str = "00000000-0000-4000-8000-000000000001";
        assert!(local_link("http://127.0.0.1:4310/#access=abc", None).is_ok());
        assert_eq!(local_link(&format!("http://127.0.0.1:4310/r/{ROOM}#access=abc"), Some(ROOM)).unwrap().path(), format!("/r/{ROOM}"));
        for (bad, room) in [
            ("https://127.0.0.1:4310/#access=abc", None),
            ("http://localhost:4310/#access=abc", None),
            ("http://127.0.0.1.evil:4310/#access=abc", None),
            ("http://user@127.0.0.1:4310/#access=abc", None),
            ("http://127.0.0.1:4310/?next=x#access=abc", None),
            ("http://127.0.0.1:4310/rooms#access=abc", None),
            ("http://127.0.0.1:4310/#access=abc", Some(ROOM)),
            ("http://127.0.0.1:4310/r/00000000-0000-4000-8000-000000000002#access=abc", Some(ROOM)),
            ("not a link", None),
        ] {
            assert!(local_link(bad, room).is_err(), "{bad}");
        }
    }

    #[test]
    fn rooms_show_clean_titles_states_and_last_wakes() {
        let list = json!({ "daemon": null, "bindings": [
            { "roomId": "r1", "title": "Launch \u{202E}plan", "agent": "builder", "harness": "claude", "wakes": { "state": "paused", "reason": "busy\nretry later" }, "lastWake": "2026-10-03T14:02:11.000Z" },
            { "roomId": "r2", "title": null, "wakes": { "state": "on" }, "lastWake": null },
            { "roomId": "r3", "title": "Old", "closed": "the room closed", "wakes": { "state": "off" } },
            { "roomId": "r4", "wakes": { "state": "unreadable", "reason": "bad watch.json" } },
        ] });
        let rows = room_rows(&list);
        assert_eq!(rows[0].0, "Launch plan: paused");
        assert_eq!(rows[0].1, vec!["Agent: builder", "Wakes: paused (busy retry later)", "Last wake: 2026-10-03 14:02 UTC", "Harness: claude"]);
        assert_eq!(rows[1].0, "Untitled room: on");
        assert_eq!(rows[1].1, vec!["Wakes: on", "Last wake: never"]);
        assert_eq!(rows[2].0, "Old: closed");
        assert_eq!(rows[3].1[0], "Wakes: unreadable (bad watch.json)");
        assert!(room_rows(&json!({})).is_empty());
    }
}
