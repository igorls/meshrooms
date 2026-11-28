//! The Remote control window (docs/flows/remote-control.md): the browsers the person let control this computer's agents,
//! whether each is online and may send prompts, and which harnesses remote prompts may reach here (none: remote control
//! is off). The person can remove a browser, change whether it may send prompts, or change the harnesses, which turns
//! remote control on or off. Everything is read and changed through the bridge (`person remote-status`, `remote-allow`,
//! `remote-trust`, `remote-revoke`), with the app's proof on stdin, and the daemon makes each change: it holds the remote
//! turns running, and stops the ones a change no longer allows.
//!
//! Like the other windows it has its own capability (`capabilities/remote.json`) granting only its commands, and each
//! command checks the window's label. A change names only a browser the window was shown; one change runs at a time.

use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const WINDOW: &str = "remote";
/// How often the state is read again while the window is open.
const REFRESH: Duration = Duration::from_secs(3);

/// What the window shows: the last state read (and whether the last read failed, so it is shown as stale), the harnesses
/// (scanned once per opening: it runs each harness), the last read's error and the last change's, kept until the next
/// change so a failed one is never lost, and whether a change is under way.
#[derive(Default)]
pub struct Remote {
    status: Option<Value>,
    harnesses: Option<Value>,
    stale: bool,
    problem: Option<String>,
    change_problem: Option<String>,
    busy: bool,
    open: bool,
    generation: u64,
}

/// A harness's name when the scan couldn't give one.
fn label(harness: &str) -> &'static str {
    match harness { "claude" => "Claude Code", "codex" => "Codex", "hermes" => "Hermes", "agy" => "Antigravity", _ => "" }
}

impl Remote {
    /// The view, every value as plain short text or a flag.
    pub fn view(&self) -> Value {
        let status = self.status.as_ref();
        let text = |row: &Value, key: &str, max: usize| row[key].as_str().map(|value| crate::text::clean(value, max)).unwrap_or_default();
        let allowed: Vec<String> = status.and_then(|s| s["policy"]["harnesses"].as_array()).map(|list| list.iter().filter_map(|h| h.as_str())
            .filter(|h| crate::control::HARNESSES.contains(h)).map(String::from).collect()).unwrap_or_default();
        let policy_known = status.is_some_and(|s| s["policy"].is_object());
        let enabled = status.is_some_and(|s| s["policy"]["enabled"] == Value::Bool(true));
        let scanned = self.harnesses.as_ref().and_then(|h| h.as_array());
        // Every harness the scan found, and every one the policy allows even if the scan didn't say (it failed): the
        // person can always untick what is on.
        let harnesses: Vec<Value> = crate::control::HARNESSES.iter().filter_map(|&harness| {
            let row = scanned.and_then(|rows| rows.iter().find(|row| row["harness"].as_str() == Some(harness)));
            let on = enabled && allowed.iter().any(|a| a == harness);
            match row {
                Some(row) => Some(json!({ "harness": harness, "label": text(row, "label", 40), "detected": row["detected"] == Value::Bool(true), "allowed": on })),
                None if on || (scanned.is_none() && self.harnesses.is_some()) => Some(json!({ "harness": harness, "label": label(harness), "detected": Value::Null, "allowed": on })),
                None => None,
            }
        }).collect();
        let browsers: Vec<Value> = status.and_then(|s| s["browsers"].as_array()).map(|rows| rows.iter().filter_map(|row| {
            let device = row["device"].as_str().filter(|d| d.len() == 64 && d.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))?;
            Some(json!({ "device": device, "name": text(row, "name", 60), "origin": text(row, "origin", 120), "addedAt": row["addedAt"].as_u64(),
                "trusted": row["trusted"] == Value::Bool(true), "online": row["online"] == Value::Bool(true), "lastSeen": row["lastSeen"].as_u64() }))
        }).collect()).unwrap_or_default();
        let connections: Vec<Value> = status.and_then(|s| s["connections"].as_array()).map(|rows| rows.iter()
            .map(|row| json!({ "origin": text(row, "origin", 120), "state": text(row, "state", 16) })).collect()).unwrap_or_default();
        json!({
            "loaded": status.is_some(), "stale": self.stale, "policyKnown": policy_known,
            "policyProblem": status.map(|s| text(s, "policyProblem", 200)).unwrap_or_default(),
            "enabled": enabled, "harnesses": harnesses, "harnessesLoaded": self.harnesses.is_some(), "browsers": browsers,
            "connections": connections, "machineKnown": status.is_some_and(|s| s["machineKnown"] == Value::Bool(true)),
            "machineProblem": status.map(|s| text(s, "problem", 200)).unwrap_or_default(),
            "problem": self.change_problem.clone().or_else(|| self.problem.clone()), "busy": self.busy,
        })
    }

    /// Whether the window was shown this browser: only those are changed.
    pub fn shows(&self, device: &str) -> bool {
        self.status.as_ref().and_then(|s| s["browsers"].as_array()).is_some_and(|rows| rows.iter().any(|row| row["device"].as_str() == Some(device)))
    }
}

/// A change the window asks for.
pub enum Change {
    Allow(Vec<String>),
    Trust { device: String, trusted: bool },
    Revoke { device: String },
}

impl Change {
    /// The bridge command for it, once checked against what the window showed.
    fn args(&self, remote: &Remote) -> Result<Vec<String>, String> {
        let shown = |device: &str| if remote.shows(device) { Ok(()) } else { Err("That browser isn't in the list any more. Look at it again.".to_string()) };
        Ok(match self {
            Change::Allow(allow) => {
                if allow.iter().any(|h| !crate::control::HARNESSES.contains(&h.as_str())) {
                    return Err("That harness can't be prompted remotely.".into());
                }
                let chosen: Vec<&str> = crate::control::HARNESSES.iter().copied().filter(|h| allow.iter().any(|a| a == h)).collect();
                vec!["person".into(), "remote-allow".into(), "--allow".into(), if chosen.is_empty() { "none".into() } else { chosen.join(",") }]
            }
            Change::Trust { device, trusted } => {
                shown(device)?;
                vec!["person".into(), "remote-trust".into(), "--device".into(), device.clone(), "--trusted".into(), if *trusted { "yes" } else { "no" }.into()]
            }
            Change::Revoke { device } => {
                shown(device)?;
                vec!["person".into(), "remote-revoke".into(), "--device".into(), device.clone()]
            }
        })
    }
}

fn state(app: &AppHandle) -> std::sync::MutexGuard<'_, Remote> {
    crate::lock(app.state::<Mutex<Remote>>().inner())
}

/// A bridge command with the app's proof on stdin.
fn run(app: &AppHandle, args: &[&str]) -> Result<Value, String> {
    crate::pair::app_proof().and_then(|proof| crate::bridge(app).and_then(|bridge| crate::bridge::cli_with_input(&bridge, args, Some(format!("{proof}\n").as_bytes()))))
}

/// Reads the state once (with the harnesses, the first time after a show): whether it could be read.
fn read(app: &AppHandle) -> bool {
    let with_harnesses = state(app).harnesses.is_none();
    let args: &[&str] = if with_harnesses { &["person", "remote-status", "--harnesses"] } else { &["person", "remote-status"] };
    let result = run(app, args);
    let mut remote = state(app);
    match result {
        Ok(mut status) => {
            if with_harnesses {
                // Null when the scan failed: the allowed harnesses still show, and the next opening scans again.
                remote.harnesses = Some(status["harnesses"].take());
            }
            remote.status = Some(status);
            remote.stale = false;
            remote.problem = None;
            true
        }
        Err(error) => {
            // What was read before stays, marked stale: the window says it can't tell, rather than show it as current.
            remote.stale = true;
            remote.problem = Some(crate::text::clean(&error, 160));
            false
        }
    }
}

/// Shows the window, and reads the state again every `REFRESH` while it is open.
pub fn show(app: &AppHandle) {
    let window = match app.get_webview_window(WINDOW) {
        Some(window) => window,
        None => match WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("remote.html".into())).title("Meshrooms: remote control").inner_size(560.0, 560.0).build() {
            Ok(window) => window,
            Err(_) => return,
        },
    };
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let _ = window.show();
    let _ = window.set_focus();
    let generation = {
        let mut remote = state(app);
        // Scanned again when the window opens (one installed meanwhile shows), not when an open one is brought forward;
        // a failure from before it was closed isn't shown again.
        if !remote.open {
            remote.harnesses = None;
            remote.change_problem = None;
        }
        remote.open = true;
        remote.generation += 1;
        remote.generation
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let mut backoff = crate::notify::Backoff::default();
        while current(&app, generation) {
            let wait = if read(&app) { backoff.succeeded(); REFRESH } else { backoff.failed() };
            std::thread::sleep(wait);
        }
    });
}

fn current(app: &AppHandle, generation: u64) -> bool {
    let remote = state(app);
    remote.open && remote.generation == generation
}

/// The window closed: its refresher stops.
pub fn closed(app: &AppHandle) {
    state(app).open = false;
}

/// A change, off the window's thread; the state is read again after.
pub fn change(app: &AppHandle, change: Change) -> Result<(), String> {
    let args = {
        let mut remote = state(app);
        if remote.busy {
            return Err("Another change is under way. Wait a moment.".into());
        }
        let args = change.args(&remote)?;
        remote.busy = true;
        remote.change_problem = None;
        args
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let result = run(&app, &refs);
        {
            let mut remote = state(&app);
            remote.busy = false;
            // Kept until the next change: the read that follows must not hide that this one failed.
            remote.change_problem = result.as_ref().err().map(|error| crate::text::clean(error, 160));
        }
        let _ = read(&app);
    });
    Ok(())
}

fn ours(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == WINDOW { Ok(()) } else { Err("Not available here.".into()) }
}

#[tauri::command]
pub fn remote_view(window: WebviewWindow) -> Result<Value, String> {
    ours(&window)?;
    Ok(state(window.app_handle()).view())
}

#[tauri::command]
pub fn remote_allow(window: WebviewWindow, allow: Vec<String>) -> Result<(), String> {
    ours(&window)?;
    change(window.app_handle(), Change::Allow(allow))
}

#[tauri::command]
pub fn remote_trust(window: WebviewWindow, device: String, trusted: bool) -> Result<(), String> {
    ours(&window)?;
    change(window.app_handle(), Change::Trust { device, trusted })
}

/// Remove: the page asks first ("Remove <name>?"), then calls this.
#[tauri::command]
pub fn remote_revoke(window: WebviewWindow, device: String) -> Result<(), String> {
    ours(&window)?;
    change(window.app_handle(), Change::Revoke { device })
}

#[tauri::command]
pub fn remote_close(window: WebviewWindow) -> Result<(), String> {
    ours(&window)?;
    closed(window.app_handle());
    let _ = window.close();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn remote(enabled: bool) -> Remote {
        Remote {
            status: Some(json!({
                "policy": { "enabled": enabled, "harnesses": ["claude", "exec"], "trusted": [LAPTOP] },
                "browsers": [
                    { "device": LAPTOP, "name": "Laptop\u{202E} browser\nsecond", "origin": "https://rooms.example", "addedAt": 1, "trusted": true, "online": true },
                    { "device": "not a device", "name": "Bad", "origin": "https://rooms.example", "addedAt": 2 },
                ],
                "connections": [{ "origin": "https://rooms.example", "state": "ready" }],
            })),
            harnesses: Some(json!([{ "harness": "claude", "label": "Claude Code", "detected": true }, { "harness": "codex", "label": "Codex", "detected": false },
                { "harness": "exec", "label": "Custom", "detected": true }])),
            ..Remote::default()
        }
    }

    #[test]
    fn the_view_is_plain_text_and_shows_nothing_allowed_while_off() {
        let view = remote(true).view();
        assert_eq!(view["browsers"].as_array().unwrap().len(), 1, "a row without a device id is left out");
        assert_eq!(view["browsers"][0]["name"], "Laptop browser second");
        assert_eq!(view["browsers"][0]["trusted"], true);
        assert_eq!(view["harnesses"], json!([
            { "harness": "claude", "label": "Claude Code", "detected": true, "allowed": true },
            { "harness": "codex", "label": "Codex", "detected": false, "allowed": false },
        ]));
        assert_eq!(view["policyKnown"], true);
        assert_eq!(remote(false).view()["harnesses"][0]["allowed"], false);
        assert_eq!(Remote::default().view()["loaded"], false);
    }

    #[test]
    fn a_failed_scan_still_shows_what_is_on_and_an_unreadable_policy_is_unknown() {
        let mut shown = remote(true);
        shown.harnesses = Some(Value::Null);
        // Every remote harness, so what is on can be turned off; nothing claims to be found or not.
        let view = shown.view();
        assert_eq!(view["harnesses"].as_array().unwrap().len(), 4);
        assert_eq!(view["harnesses"][0], json!({ "harness": "claude", "label": "Claude Code", "detected": null, "allowed": true }));
        let mut unknown = remote(true);
        unknown.status = Some(json!({ "policy": null, "policyProblem": "This machine's remote control policy can't be read.", "browsers": [], "connections": [] }));
        let view = unknown.view();
        assert_eq!(view["policyKnown"], false);
        assert_eq!(view["enabled"], false);
        assert_eq!(view["policyProblem"], "This machine's remote control policy can't be read.");
    }

    #[test]
    fn a_failed_change_stays_shown_after_the_next_read_and_a_failed_read_marks_the_view_stale() {
        let mut shown = remote(true);
        shown.change_problem = Some("The daemon refused it.".into());
        shown.problem = None;
        assert_eq!(shown.view()["problem"], "The daemon refused it.");
        shown.stale = true;
        assert_eq!(shown.view()["stale"], true);
    }

    #[test]
    fn changes_name_only_what_the_window_showed() {
        let shown = remote(true);
        assert_eq!(Change::Allow(vec!["codex".into(), "claude".into()]).args(&shown).unwrap().join(" "), "person remote-allow --allow claude,codex");
        assert_eq!(Change::Allow(vec![]).args(&shown).unwrap().join(" "), "person remote-allow --allow none");
        assert!(Change::Allow(vec!["exec".into()]).args(&shown).is_err());
        assert_eq!(Change::Trust { device: LAPTOP.into(), trusted: false }.args(&shown).unwrap().join(" "), format!("person remote-trust --device {LAPTOP} --trusted no"));
        assert_eq!(Change::Revoke { device: LAPTOP.into() }.args(&shown).unwrap().join(" "), format!("person remote-revoke --device {LAPTOP}"));
        let other = "b".repeat(64);
        assert!(Change::Revoke { device: other.clone() }.args(&shown).is_err());
        assert!(Change::Trust { device: other, trusted: true }.args(&shown).is_err());
        assert!(Change::Revoke { device: LAPTOP.into() }.args(&Remote::default()).is_err());
    }

    #[test]
    fn the_window_may_call_its_five_commands_only() {
        let capability: Value = serde_json::from_str(include_str!("../capabilities/remote.json")).unwrap();
        assert_eq!(capability["windows"], json!([WINDOW]));
        assert_eq!(capability["permissions"], json!(["allow-remote-view", "allow-remote-allow", "allow-remote-trust", "allow-remote-revoke", "allow-remote-close"]));
    }
}
