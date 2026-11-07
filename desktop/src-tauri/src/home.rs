//! The desktop status window reads cached state and offers the tray's fixed actions. Room pages never get these
//! commands: the capability is scoped to `main`, and callers must still be on the bundled index page.

use serde_json::{json, Value};
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Debug, PartialEq)]
pub struct Room {
    pub id: String,
    pub title: String,
    pub state: String,
    pub unread: u64,
    pub mentions: u64,
    pub waiting: usize,
}

impl Room {
    fn view(&self) -> Value {
        json!({"id": self.id, "title": self.title, "state": self.state, "unread": self.unread, "mentions": self.mentions, "waiting": self.waiting})
    }
}

/// Personal room summaries only. Agent bindings, origins, keys and runner details never enter this view.
pub fn rooms(value: &Value) -> Result<Vec<Room>, String> {
    let rows = value.as_array().ok_or("Cannot read your rooms. Refresh status to try again.")?;
    let mut seen = std::collections::HashSet::new();
    Ok(rows.iter().filter_map(|row| {
        let id = row["roomId"].as_str()?;
        let state = row["state"].as_str()?;
        if !crate::links::room_id(id) || !matches!(state, "joined" | "waiting" | "starting" | "declined" | "expired") || !seen.insert(id) {
            return None;
        }
        let title = crate::text::clean(row["title"].as_str().unwrap_or(""), 80);
        let unread = row["unread"].as_u64().unwrap_or(0).min(9999);
        Some(Room {
            id: id.into(), title: if title.is_empty() { "Untitled room".into() } else { title }, state: state.into(), unread,
            mentions: row["mentions"].as_u64().unwrap_or(0).min(unread),
            waiting: row["waiting"].as_array().map_or(0, Vec::len),
        })
    }).take(64).collect())
}

pub struct Home {
    pub running: Option<bool>,
    pub detail: String,
    pub problem: Option<String>,
    pub pending: usize,
    pub activity: String,
    pub login_on: bool,
    pub login_enabled: bool,
    pub login_label: String,
    pub approvals: Option<u64>,
    pub rooms: Option<Vec<Room>>,
    pub rooms_problem: Option<String>,
}

impl Default for Home {
    fn default() -> Self {
        Self {
            running: None,
            detail: "Checking the background connection…".into(),
            problem: None,
            pending: 0,
            activity: String::new(),
            login_on: false,
            login_enabled: false,
            login_label: "Checking start at login…".into(),
            approvals: None,
            rooms: None,
            rooms_problem: None,
        }
    }
}

impl Home {
    pub fn knows_room(&self, room: &str) -> bool {
        self.rooms.as_ref().is_some_and(|rooms| rooms.iter().any(|known| known.id == room))
    }

    pub fn view(&self) -> Value {
        json!({
            "running": self.running, "detail": self.detail, "problem": self.problem,
            "busy": self.pending > 0, "activity": self.activity,
            "loginOn": self.login_on, "loginEnabled": self.login_enabled, "loginLabel": self.login_label,
            "approvals": self.approvals,
            "rooms": self.rooms.as_ref().map(|rooms| rooms.iter().map(Room::view).collect::<Vec<_>>()), "roomsProblem": self.rooms_problem,
        })
    }
}

fn allowed(action: &str) -> bool {
    matches!(action, "open" | "room" | "start" | "stop" | "login" | "logs" | "review" | "approvals" | "refresh")
}

fn trusted(label: &str, url: &tauri::Url, origin: &tauri::Url) -> bool {
    label == "main" && url.scheme() == origin.scheme() && url.host_str() == origin.host_str()
        && url.port_or_known_default() == origin.port_or_known_default() && url.username().is_empty() && url.password().is_none()
        && matches!(url.path(), "" | "/" | "/index.html")
}

fn ours(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "Cannot read this window's address.")?;
    if trusted(window.label(), &url, &crate::app_origin(window.app_handle())) {
        Ok(())
    } else {
        Err("Not available here.".into())
    }
}

#[tauri::command]
pub fn home_view(window: WebviewWindow) -> Result<Value, String> {
    ours(&window)?;
    Ok(crate::lock(&window.state::<crate::Shell>().home).view())
}

#[tauri::command]
pub async fn home_action(window: WebviewWindow, action: String, room: Option<String>) -> Result<(), String> {
    ours(&window)?;
    if !allowed(&action) || (action == "room") != room.is_some() {
        return Err("That action is not available here.".into());
    }
    if crate::lock(&window.state::<crate::Shell>().home).pending > 0 {
        return Err("Wait for the current action to finish, then try again.".into());
    }
    // Window creation must not block the IPC/event callback, especially on Windows.
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(room) = room { crate::open_owned_room(&app, &room) }
        else { crate::menu_action(&app, &action); Ok(()) }
    }).await.map_err(|_| "The desktop action did not finish. Try again.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_shortcuts_use_only_valid_personal_room_ids_and_inert_bounded_labels() {
        const ID: &str = "00000000-0000-4000-8000-000000000001";
        let rows = rooms(&json!([
            {"roomId": ID, "title": "R&D\nroom", "state": "joined", "unread": 2, "mentions": 8, "waiting": [{}], "origin": "https://secret.example"},
            {"roomId": ID, "title": "Duplicate", "state": "joined"},
            {"roomId": "https://example.com", "state": "joined"},
            {"roomId": "00000000-0000-4000-8000-000000000002", "state": "closed"},
            {"roomId": "00000000-0000-4000-8000-000000000003", "state": "waiting", "title": null}
        ])).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].mentions, 2);
        assert_eq!(rows[0].waiting, 1);
        assert!(!rows[0].title.contains('\n'));
        assert_eq!(rows[1].title, "Untitled room");
        assert!(rows[0].view().get("origin").is_none());
        assert!(rooms(&json!({"rooms": []})).is_err());
        assert!(rooms(&json!([])).unwrap().is_empty());
        let mut home = Home::default();
        assert!(!home.knows_room(ID));
        home.rooms = Some(rows);
        assert!(home.knows_room(ID));
        assert!(!home.knows_room("00000000-0000-4000-8000-000000000002"));
        assert!(!home.knows_room("https://example.com"));
    }

    #[test]
    fn status_starts_unknown_and_reports_stopped_and_errors_without_claiming_to_run() {
        let mut home = Home::default();
        assert!(home.view()["running"].is_null());
        home.running = Some(false);
        home.problem = Some("The daemon did not start.".into());
        home.pending = 1;
        assert_eq!(home.view()["running"], false);
        assert_eq!(home.view()["busy"], true);
        assert_eq!(home.view()["problem"], "The daemon did not start.");
    }

    #[test]
    fn only_the_bundled_home_window_can_use_the_controls() {
        let origin = tauri::Url::parse("tauri://localhost/").unwrap();
        assert!(trusted("main", &tauri::Url::parse("tauri://localhost").unwrap(), &origin));
        assert!(trusted("main", &origin.join("index.html").unwrap(), &origin));
        for (label, url) in [
            ("review", "tauri://localhost/index.html"),
            ("main", "tauri://localhost/pair.html"),
            ("main", "tauri://localhost.evil/index.html"),
            ("main", "tauri://user@localhost/index.html"),
            ("main", "http://127.0.0.1:4310/index.html"),
            ("main", "https://example.com/index.html"),
        ] {
            assert!(!trusted(label, &tauri::Url::parse(url).unwrap(), &origin));
        }
        assert!(allowed("refresh"));
        assert!(!allowed("quit"));
        assert!(!allowed("unpair"));
        assert!(!allowed("daemon start --anything"));
    }

    #[test]
    fn the_home_capability_is_local_to_main_and_grants_no_other_commands() {
        let capability: Value = serde_json::from_str(include_str!("../capabilities/home.json")).unwrap();
        assert_eq!(capability["windows"], json!(["main"]));
        assert_eq!(capability["permissions"], json!(["allow-home-view", "allow-home-action"]));
        assert!(capability["remote"].is_null());
    }
}
