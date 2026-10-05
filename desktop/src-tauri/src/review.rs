//! The Review window: every agent the person bound, as the daemon sees it (`agent review`): its room, whether it is live
//! and listening, paused (with the reason), waiting for the host, starting, or failed, and a Pause or Resume for each
//! (`agent pause|resume`, which keep the binding: Resume binds the same session again, never a new one). The "agents
//! live" notification opens it (notify.rs). A binding that did not come back is listed as failed, never left out.
//!
//! An agent whose watcher holds its wakes (a broken confinement or an approval wall paused it, or it halted, a run from
//! before a restart perhaps still going) has no Pause, and its Resume asks first, naming why waking stopped: Resume
//! sends the hold's time back, and the daemon resumes only past that very hold.
//!
//! Like the pairing and join windows it has its own capability (`capabilities/review.json`) granting only its commands,
//! and each command checks the window's label. Pause and Resume name a room and a member the window was shown; the
//! bridge takes the app's proof on stdin for both, and the daemon makes the change.

use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const WINDOW: &str = "review";
/// How often the list is read again while the window is open.
const REFRESH: Duration = Duration::from_secs(3);

/// What the window shows: the last review read, the last error, and whether a change is under way.
#[derive(Default)]
pub struct Reviewing {
    review: Option<Value>,
    problem: Option<String>,
    busy: bool,
    /// The window is open: its refresher runs.
    open: bool,
    /// The refresher that may run: each show starts one with a new generation, and an older one ends at its next turn.
    generation: u64,
}

impl Reviewing {
    /// The view: each agent as inert text (name, room, state, reason) with its ids and what it may do.
    pub fn view(&self) -> Value {
        let agents: Vec<Value> = self
            .review
            .as_ref()
            .and_then(|review| review["agents"].as_array().cloned())
            .unwrap_or_default()
            .iter()
            .map(|row| {
                let text = |key: &str, max: usize| row[key].as_str().map(|value| crate::text::clean(value, max)).unwrap_or_default();
                let hold = &row["hold"];
                json!({
                    "roomId": text("roomId", 36), "memberId": text("memberId", 36), "name": text("name", 40), "title": text("title", 60),
                    "state": text("state", 16), "reason": text("reason", 300),
                    "canPause": row["canPause"] == Value::Bool(true) && hold.is_null(), "canResume": row["canResume"] == Value::Bool(true),
                    // What the watcher holds the wakes for: Resume asks first, naming it (and the process a halt is checking).
                    "hold": if hold.is_object() { json!({ "at": hold["at"].as_u64(), "reason": hold["reason"].as_str().map(|r| crate::text::clean(r, 300)).unwrap_or_default(),
                        "pid": hold["pid"].as_u64() }) } else { Value::Null },
                })
            })
            .collect();
        json!({ "loaded": self.review.is_some(), "agents": agents, "summary": self.review.as_ref().map(|r| r["summary"].clone()).unwrap_or(Value::Null),
            "problem": self.problem.clone(), "busy": self.busy })
    }

    /// Whether the window was shown this agent (by room and member), with the action allowed: only those are changed. A
    /// held agent is never paused, and resumes only with `confirm` naming the hold it showed.
    pub fn allows(&self, room: &str, member: &str, resume: bool, confirm: Option<u64>) -> bool {
        self.review.as_ref().and_then(|review| review["agents"].as_array()).is_some_and(|rows| {
            rows.iter().any(|row| {
                let held = row["hold"]["at"].as_u64();
                row["roomId"].as_str() == Some(room)
                    && row["memberId"].as_str() == Some(member)
                    && row[if resume { "canResume" } else { "canPause" }] == Value::Bool(true)
                    && if resume { held == confirm } else { held.is_none() && row["hold"].is_null() }
            })
        })
    }
}

fn state(app: &AppHandle) -> std::sync::MutexGuard<'_, Reviewing> {
    crate::lock(app.state::<Mutex<Reviewing>>().inner())
}

#[cfg(debug_assertions)]
fn trace(what: &str) {
    eprintln!("review: {what}");
}
#[cfg(not(debug_assertions))]
fn trace(_: &str) {}

/// A review read elsewhere (the start notice's): kept for the window.
pub fn refreshed(app: &AppHandle, review: Value) {
    state(app).review = Some(review);
}

/// Reads the list once: whether it could be read.
fn read(app: &AppHandle) -> bool {
    let result = crate::pair::app_proof()
        .and_then(|proof| crate::bridge(app).and_then(|bridge| crate::bridge::cli_with_input(&bridge, &["agent", "review"], Some(format!("{proof}\n").as_bytes()))));
    let mut reviewing = state(app);
    match result {
        Ok(review) => {
            reviewing.review = Some(review);
            if !reviewing.busy {
                reviewing.problem = None;
            }
            true
        }
        Err(error) => {
            reviewing.problem = Some(crate::text::clean(&error, 160));
            false
        }
    }
}

/// Shows the window, and reads the list again every `REFRESH` while it is open.
pub fn show(app: &AppHandle) {
    let window = match app.get_webview_window(WINDOW) {
        Some(window) => window,
        None => match WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("review.html".into())).title("Meshrooms: your agents").inner_size(560.0, 520.0).build() {
            Ok(window) => window,
            Err(_) => return,
        },
    };
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let _ = window.show();
    let _ = window.set_focus();
    // A new refresher for this show; one from an earlier show ends at its next turn, so reopening never adds one.
    let generation = {
        let mut reviewing = state(app);
        reviewing.open = true;
        reviewing.generation += 1;
        reviewing.generation
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let mut backoff = crate::notify::Backoff::default();
        while current(&app, generation) {
            let wait = if read(&app) {
                backoff.succeeded();
                REFRESH
            } else {
                backoff.failed()
            };
            std::thread::sleep(wait);
        }
        trace("refresher ended");
    });
}

/// Whether the refresher of `generation` is still the one that may run: the window is open and wasn't shown again since.
fn current(app: &AppHandle, generation: u64) -> bool {
    let reviewing = state(app);
    reviewing.open && reviewing.generation == generation
}

/// The window closed: its refresher stops.
pub fn closed(app: &AppHandle) {
    state(app).open = false;
}

/// Pause or Resume for an agent the window showed, off the window's thread; the list is read again after. `confirm`: the
/// time of the hold the person confirmed resuming past, when the window showed one.
pub fn change(app: &AppHandle, room: String, member: String, resume: bool, confirm: Option<u64>) -> Result<(), String> {
    {
        let mut reviewing = state(app);
        if reviewing.busy {
            return Err("Another change is under way. Wait a moment.".into());
        }
        if !reviewing.allows(&room, &member, resume, confirm) {
            return Err("That agent can't be changed that way now. Look at the list again.".into());
        }
        reviewing.busy = true;
        reviewing.problem = None;
    }
    trace(if resume { "resuming" } else { "pausing" });
    let app = app.clone();
    std::thread::spawn(move || {
        let verb = if resume { "resume" } else { "pause" };
        let confirm = confirm.map(|at| at.to_string());
        let mut args = vec!["agent", verb, "--room", room.as_str(), "--member", member.as_str()];
        if let Some(at) = &confirm {
            args.extend(["--confirm-hold", at.as_str()]);
        }
        let result = crate::pair::app_proof()
            .and_then(|proof| crate::bridge(&app).and_then(|bridge| crate::bridge::cli_with_input(&bridge, &args, Some(format!("{proof}\n").as_bytes()))));
        {
            let mut reviewing = state(&app);
            reviewing.busy = false;
            if let Err(error) = &result {
                reviewing.problem = Some(crate::text::clean(error, 160));
            }
        }
        trace(if result.is_ok() { "changed" } else { "change failed" });
        let _ = read(&app);
    });
    Ok(())
}

pub fn ours_label(label: &str) -> Result<(), String> {
    if label == WINDOW { Ok(()) } else { Err("Not available here.".into()) }
}
fn ours(window: &WebviewWindow) -> Result<(), String> {
    ours_label(window.label())
}

#[tauri::command]
pub fn review_view(window: WebviewWindow) -> Result<Value, String> {
    ours(&window)?;
    Ok(state(window.app_handle()).view())
}

#[tauri::command]
pub fn review_pause(window: WebviewWindow, room: String, member: String) -> Result<(), String> {
    ours(&window)?;
    change(window.app_handle(), room, member, false, None)
}

/// `confirm`: the hold's time, once the person confirmed resuming past it in the window.
#[tauri::command]
pub fn review_resume(window: WebviewWindow, room: String, member: String, confirm: Option<u64>) -> Result<(), String> {
    ours(&window)?;
    change(window.app_handle(), room, member, true, confirm)
}

#[tauri::command]
pub fn review_close(window: WebviewWindow) -> Result<(), String> {
    ours(&window)?;
    closed(window.app_handle());
    let _ = window.close();
    Ok(())
}

/// Development builds: Pause or Resume the agent at `index` in the list, through the same code as the buttons
/// (`confirm`: as the confirm step's Resume anyway does, with the hold the list shows).
#[cfg(debug_assertions)]
pub fn dev_change(app: &AppHandle, index: &str, resume: bool, confirm: bool) -> Result<(), String> {
    let (room, member, held) = {
        let reviewing = state(app);
        let rows = reviewing.review.as_ref().and_then(|review| review["agents"].as_array().cloned()).unwrap_or_default();
        let row = index.parse::<usize>().ok().and_then(|i| rows.get(i).cloned()).ok_or("No such agent in the list.")?;
        (row["roomId"].as_str().unwrap_or_default().to_string(), row["memberId"].as_str().unwrap_or_default().to_string(), row["hold"]["at"].as_u64())
    };
    change(app, room, member, resume, if confirm { held } else { None })
}

/// Development builds: what the window shows now.
#[cfg(debug_assertions)]
pub fn dev_view(app: &AppHandle) -> Value {
    state(app).view()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM: &str = "00000000-0000-4000-8000-000000000001";
    const MEMBER: &str = "00000000-0000-4000-8000-000000000002";

    fn reviewing() -> Reviewing {
        Reviewing { review: Some(json!({ "summary": { "live": 1, "rooms": 1 }, "agents": [
            { "roomId": ROOM, "memberId": MEMBER, "name": "Wren\u{202E}", "title": "Launch", "state": "live", "canPause": true, "canResume": false },
            { "roomId": ROOM, "memberId": null, "name": "Oak", "title": "Launch", "state": "failed", "reason": "Its runner\nis not running.", "canPause": false, "canResume": false },
        ] })), ..Reviewing::default() }
    }

    #[test]
    fn the_view_is_inert_text_and_keeps_failed_agents() {
        let view = reviewing().view();
        assert_eq!(view["agents"].as_array().unwrap().len(), 2);
        assert_eq!(view["agents"][0]["name"], "Wren");
        assert_eq!(view["agents"][1], json!({ "roomId": ROOM, "memberId": "", "name": "Oak", "title": "Launch", "state": "failed", "reason": "Its runner is not running.", "canPause": false, "canResume": false, "hold": null }));
        assert_eq!(Reviewing::default().view()["loaded"], false);
    }

    #[test]
    fn only_an_agent_the_window_showed_is_changed_and_only_as_it_allows() {
        let r = reviewing();
        assert!(r.allows(ROOM, MEMBER, false, None));
        assert!(!r.allows(ROOM, MEMBER, true, None), "a live agent has nothing to resume");
        assert!(!r.allows(ROOM, "00000000-0000-4000-8000-000000000009", false, None));
        assert!(!r.allows("x", MEMBER, false, None));
        assert!(!Reviewing::default().allows(ROOM, MEMBER, false, None));
    }

    #[test]
    fn a_held_agent_is_never_paused_and_resumes_only_past_the_hold_the_window_named() {
        let r = Reviewing { review: Some(json!({ "agents": [
            { "roomId": ROOM, "memberId": MEMBER, "name": "Wren", "title": "Launch", "state": "failed", "reason": "a run from before the restart (pid 4242) may still be going",
              "hold": { "kind": "halted", "reason": "a run from before the restart (pid 4242) may still be going", "at": 1_700_000_000_002u64, "pid": 4242 },
              "canPause": true, "canResume": true },
        ] })), ..Reviewing::default() };
        let view = r.view();
        assert_eq!(view["agents"][0]["canPause"], false, "no Pause over a hold, whatever the list says");
        assert_eq!(view["agents"][0]["hold"], json!({ "at": 1_700_000_000_002u64, "reason": "a run from before the restart (pid 4242) may still be going", "pid": 4242 }));
        assert!(!r.allows(ROOM, MEMBER, false, None));
        assert!(!r.allows(ROOM, MEMBER, true, None), "not without the confirm step");
        assert!(!r.allows(ROOM, MEMBER, true, Some(1_700_000_000_001)), "not past another hold");
        assert!(r.allows(ROOM, MEMBER, true, Some(1_700_000_000_002)));
    }

    #[test]
    fn no_window_may_post_notifications_and_the_review_window_gets_its_commands_only() {
        for (name, text) in [
            ("pair", include_str!("../capabilities/pair.json")),
            ("join", include_str!("../capabilities/join.json")),
            ("review", include_str!("../capabilities/review.json")),
            ("approvals", include_str!("../capabilities/approvals.json")),
        ] {
            let capability: Value = serde_json::from_str(text).unwrap();
            let permissions: Vec<&str> = capability["permissions"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
            assert!(permissions.iter().all(|p| p.starts_with("allow-") && !p.contains(':') && !p.contains("notification")), "{name}: {permissions:?}");
            if name == "review" {
                assert_eq!(capability["windows"], json!(["review"]));
                assert_eq!(permissions, ["allow-review-view", "allow-review-pause", "allow-review-resume", "allow-review-close"]);
            }
        }
    }

    #[test]
    fn only_the_review_window_may_use_its_commands() {
        assert!(ours_label(WINDOW).is_ok());
        for other in ["main", "pair", "join", "notice-1", ""] {
            assert!(ours_label(other).is_err(), "{other}");
        }
    }
}
