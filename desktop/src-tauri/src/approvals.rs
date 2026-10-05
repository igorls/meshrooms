//! The Approvals window (internal/docs/design/desktop-first.md, "Approvals stay native"): what waits for the person's
//! approval in the app (`agent approvals`), and their answer to each (`agent approve|reject`). Two kinds wait:
//!
//! - an agent identity asked for with `meshrooms agent request` (a name, a harness, a model): approving makes the
//!   identity and nothing else;
//! - binding an identity in a room to an EXISTING session, asked for from the localhost page: the window names the
//!   identity, the room, the harness, the session's title and folder label, and the full folder the run will work in;
//!   approving binds exactly that session there.
//!
//! The daemon gives each request with a digest of what it says, and for a bind of the labels it is shown with (the
//! identity's name and the model the bind runs it with, the room's title), the ids shown beside them. Approve sends
//! back the digest of the request exactly as the window showed it, and the daemon refuses (409) a request that changed
//! since: the window then shows it again, marked "This changed since you opened it. Check it again.", and never
//! approves it on its own. A request with something the window can't show exactly as it is (an invisible or control
//! character, a doubled space) is shown with those spelled out (`visible`) and can only be rejected. Who filed a request
//! is never taken from the request: the window says the daemon doesn't record it. Reject is one click.
//!
//! It also makes custom-command (exec) agents, the only place one is made: a name, the command and an optional model.
//! Review reads the command back through the bridge (`agent custom --check`) and shows it exactly, with the program and
//! each argument a wake runs; Make this agent makes exactly that one (`agent custom`, the command on stdin). Such a
//! command runs on this computer, as the person, whenever the agent wakes.
//!
//! Like the pairing, join and Review windows it has its own capability (`capabilities/approvals.json`) granting only its
//! commands, and each command checks the window's label. The bridge takes the app's proof on stdin for every command.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const WINDOW: &str = "approvals";
/// How often the list is read again while the window is open.
const REFRESH: Duration = Duration::from_secs(3);
/// What a request that changed since the window showed it says, once shown again.
pub const CHANGED: &str = "This changed since you opened it. Check it again.";
/// The longest working folder the window shows (the daemon's own limit).
const MAX_FOLDER: usize = 4_096;

/// What the window shows: the last list read, the last error, what the last answer did, and whether one is under way.
#[derive(Default)]
pub struct Approving {
    /// The last `agent approvals` answer: `{ approvals: [...] }`, each with its digest.
    list: Option<Value>,
    problem: Option<String>,
    /// What the last answer did ("Made Elm.", "Rejected.").
    note: Option<String>,
    busy: bool,
    /// The window is open: its refresher runs.
    open: bool,
    /// The refresher that may run: each show starts one with a new generation, and an older one ends at its next turn.
    generation: u64,
    /// The digest the window was last given for each request: another one for the same request means it changed.
    given: HashMap<String, String>,
    /// Requests that changed since the window first showed them: shown with `CHANGED` until answered.
    changed: HashSet<String>,
    /// Why the daemon refused to approve a request that did not change (its harness isn't installed, say).
    refused: HashMap<String, String>,
    /// The custom-command form: its last problem, and how many agents it made (the window clears the form on a new one).
    custom_problem: Option<String>,
    made: u64,
    /// The custom-command agent the window shows for confirmation: as the bridge read it (`agent custom --check`), the
    /// command exactly, its program and each argument. Make makes exactly this one.
    custom: Option<CustomPreview>,
}

/// A custom-command agent as it would be made and run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CustomPreview {
    pub name: String,
    pub command: String,
    pub program: String,
    pub args: Vec<String>,
    pub model: Option<String>,
}

impl CustomPreview {
    /// The bridge's preview, only when it is of exactly the name, command and model sent, and every part of it can be
    /// shown exactly.
    pub fn of(answer: &Value, sent: &(String, String, Option<String>)) -> Result<CustomPreview, String> {
        if answer["ok"] != Value::Bool(true) {
            return Err(crate::text::clean(answer["error"].as_str().unwrap_or("The command was refused."), 300));
        }
        let text = |key: &str| answer[key].as_str().map(str::to_string);
        let args: Option<Vec<String>> = answer["args"].as_array().map(|args| args.iter().filter_map(|a| a.as_str().map(str::to_string)).collect());
        let preview = CustomPreview { name: text("name").unwrap_or_default(), command: text("command").unwrap_or_default(), program: text("program").unwrap_or_default(),
            args: args.unwrap_or_default(), model: text("model") };
        let same = preview.name == sent.0 && preview.command == sent.1 && preview.model == sent.2
            && answer["args"].as_array().is_some_and(|args| args.len() == preview.args.len());
        let plain = |t: &str| !t.chars().any(|c| c.is_control() || crate::text::invisible(c));
        if !same || preview.program.is_empty() || !plain(&preview.program) || !preview.args.iter().all(|a| plain(a)) {
            return Err("The command could not be read back exactly as typed. Check it and try again.".into());
        }
        Ok(preview)
    }

    fn view(&self) -> Value {
        json!({ "name": self.name, "command": self.command, "program": self.program, "args": self.args, "model": self.model,
            "nonAscii": { "name": !self.name.is_ascii(), "command": !self.command.is_ascii() } })
    }
}

/// Whether a request may be approved with the digest the window sent.
#[derive(Debug, PartialEq, Eq)]
pub enum Allowed {
    /// The window showed it as it stands: ask the daemon.
    Yes,
    /// It changed since the window showed it: show it again.
    Changed,
    /// It is not waiting any more (or the window never showed it).
    Gone,
    /// It holds something the window can't show exactly: it can only be rejected.
    Inexact,
}

/// What an answer to Approve came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Approved,
    /// Refused because the request changed since it was shown (a 409, and the list now gives it another digest).
    Changed,
    /// Refused for another reason (shown on the request), or the bridge failed.
    Refused(String),
}

fn harness_label(harness: &str) -> Option<&'static str> {
    match harness {
        "claude" => Some("Claude Code"),
        "codex" => Some("Codex"),
        "hermes" => Some("Hermes"),
        _ => None,
    }
}

/// Text the window can show exactly as it is: `text::clean` leaves it unchanged (no control or invisible characters, no
/// other whitespace than single spaces, no space at either end) and it fits `max`.
pub fn exact(text: &str, max: usize) -> bool {
    !text.is_empty() && crate::text::clean(text, max) == text
}

/// Text as it is, with every character `exact` refuses spelled out (`\u{202E}`), a tab or line break included, and any
/// space at either end or beside another made visible too: what a request that can't be approved here really holds.
pub fn visible(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    for (i, &c) in chars.iter().enumerate() {
        let odd_space = c == ' ' && (i == 0 || i + 1 == chars.len() || chars.get(i + 1) == Some(&' ') || (i > 0 && chars[i - 1] == ' '));
        if c.is_control() || crate::text::invisible(c) || (c.is_whitespace() && c != ' ') || odd_space {
            out.push_str(&format!("\\u{{{:04X}}}", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

/// Who asked, as the window says it: never text from the request, which anything that files one could word as it likes.
/// The daemon records neither which program ran `agent request` nor which client of its local API filed a bind.
pub const IDENTITY_PROVENANCE: &str = "Filed on this computer with meshrooms agent request, by an agent or another program of yours. Which one is not recorded. Approving makes this identity only: it joins no room and binds no session.";
pub const BIND_PROVENANCE: &str = "Filed on this computer through the local Meshrooms page's API: by the page, or by another program of yours. Which one is not recorded. The session's conversation so far comes into the room with it, and its wakes run in the working folder above.";

/// The rows marked when they hold a non-ASCII character: the names a request makes or binds, and the folder it works in.
const MARKED_ROWS: [&str; 3] = ["Name", "Agent", "Working folder"];

/// A request id or digest as the daemon gives them; anything else is no request.
fn id_like(text: &str) -> bool {
    text.len() == 36 && text.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}
fn digest_like(text: &str) -> bool {
    text.len() == 64 && text.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// One request as the window shows it: rows of label and value (inert text, in order), who asked, and whether it can be
/// approved here. `None` for an entry that is no request (no id or digest, an unknown kind).
pub fn item(entry: &Value) -> Option<Value> {
    let id = entry["id"].as_str().filter(|id| id_like(id))?;
    let digest = entry["digest"].as_str().filter(|digest| digest_like(digest))?;
    let raw = |key: &str| entry[key].as_str();
    // Every field the digest covers is shown exactly, or the request can't be approved here: one that isn't is shown
    // with its invisible characters spelled out (`visible`), never cleaned into something it is not.
    let whole = std::cell::Cell::new(true);
    let shown = |value: Option<&str>, max: usize, absent: &str| -> String {
        match value {
            Some(text) if exact(text, max) => text.to_string(),
            Some(text) => {
                whole.set(false);
                visible(text)
            }
            None => absent.to_string(),
        }
    };
    // A label the daemon adds to a bind (its digest covers it): present, as text or null, or the request is refused here.
    let label = |key: &str, max: usize, absent: &str| -> String {
        match &entry[key] {
            Value::String(text) => shown(Some(text), max, absent),
            Value::Null if entry.get(key).is_some() => absent.to_string(),
            _ => {
                whole.set(false);
                absent.to_string()
            }
        }
    };
    let harness = raw("harness").unwrap_or_default();
    let harness_shown = match harness_label(harness) {
        Some(label) => label.to_string(),
        None => {
            whole.set(false);
            visible(harness)
        }
    };
    let asked = raw("requestedAt").map(crate::text::when).unwrap_or_default();
    let (kind, heading, rows, who) = match raw("kind") {
        Some("identity") => {
            let name = shown(raw("name"), 64, "");
            let model = shown(raw("model"), 100, "The harness's default");
            if name.is_empty() {
                whole.set(false);
            }
            let rows = vec![("Name", name), ("Harness", harness_shown), ("Model", model)];
            // Who asked is never the request's own say: the daemon doesn't record it, and the window says so.
            ("identity", "An agent asks for an identity", rows, IDENTITY_PROVENANCE)
        }
        Some("bind-existing") => {
            // The identity's name and model (the bind runs it with that model) and the room's title, as the daemon looked
            // them up for this view; the digest covers them with the request, and the ids are shown beside them.
            let agent = label("identityName", 64, "An agent of yours that was not found");
            let model = label("identityModel", 100, "The harness's default");
            let room = label("roomTitle", 60, "A room of yours, untitled");
            let agent_id = shown(raw("identityId").filter(|id| id_like(id)), 36, "");
            let room_id = shown(raw("roomId").filter(|id| id_like(id)), 36, "");
            if agent_id.is_empty() || room_id.is_empty() {
                whole.set(false);
            }
            let title = shown(raw("title"), 60, "Untitled session");
            let folder = shown(raw("folder"), 40, "None");
            let session = shown(raw("session"), 128, "");
            let cwd = match &entry["cwd"] {
                Value::Null if harness == "codex" => "The room's own folder (Codex always works there)".to_string(),
                Value::String(cwd) => shown(Some(cwd), MAX_FOLDER, ""),
                _ => {
                    whole.set(false);
                    String::new()
                }
            };
            if session.is_empty() || cwd.is_empty() {
                whole.set(false);
            }
            let rows = vec![("Agent", agent), ("Agent id", agent_id), ("Model", model), ("Room", room), ("Room id", room_id), ("Harness", harness_shown),
                ("Session", title), ("Folder label", folder), ("Working folder", cwd), ("Session id", session)];
            ("bind-existing", "Bind an agent to an existing session", rows, BIND_PROVENANCE)
        }
        _ => return None,
    };
    // A name or folder with any non-ASCII character is marked: a homoglyph (a Cyrillic а for a Latin a) can't be told
    // apart by eye, so the window says it is there.
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|(label, value)| json!({ "label": label, "value": value, "nonAscii": MARKED_ROWS.contains(&label) && !value.is_ascii() }))
        .collect();
    Some(json!({ "id": id, "digest": digest, "kind": kind, "heading": heading, "rows": rows, "who": who, "asked": asked, "canApprove": whole.get() }))
}

impl Approving {
    /// The ids of the requests in a list, in order.
    fn ids(list: Option<&Value>) -> Vec<String> {
        list.and_then(|list| list["approvals"].as_array()).map(|list| list.iter().filter_map(|a| a["id"].as_str().map(str::to_string)).collect()).unwrap_or_default()
    }

    /// A list read again: what the last answer did is no longer said once another request comes or one goes, so a note
    /// never stands beside requests it isn't about.
    pub fn listed(&mut self, list: Value) {
        if Self::ids(self.list.as_ref()) != Self::ids(Some(&list)) {
            self.note = None;
        }
        self.list = Some(list);
    }

    fn entries(&self) -> Vec<Value> {
        self.list.as_ref().and_then(|list| list["approvals"].as_array().cloned()).unwrap_or_default()
    }

    /// The view: each request as inert text, marked when it changed since shown, or refused.
    pub fn view(&mut self) -> Value {
        let items: Vec<Value> = self
            .entries()
            .iter()
            .filter_map(item)
            .map(|mut shown| {
                let id = shown["id"].as_str().unwrap_or_default().to_string();
                let digest = shown["digest"].as_str().unwrap_or_default().to_string();
                // Another digest than the one the window was given: the request changed while it was open.
                if self.given.insert(id.clone(), digest.clone()).is_some_and(|before| before != digest) {
                    self.changed.insert(id.clone());
                    self.refused.remove(&id);
                }
                shown["changed"] = if self.changed.contains(&id) { Value::String(CHANGED.into()) } else { Value::Null };
                shown["refused"] = self.refused.get(&id).map(|why| Value::String(why.clone())).unwrap_or(Value::Null);
                shown
            })
            .collect();
        json!({ "loaded": self.list.is_some(), "items": items, "problem": self.problem.clone(), "note": self.note.clone(), "busy": self.busy,
            "customProblem": self.custom_problem.clone(), "made": self.made, "custom": self.custom.as_ref().map(CustomPreview::view) })
    }

    /// The request `id` as the list gives it now, shown.
    fn shown(&self, id: &str) -> Option<Value> {
        self.entries().iter().filter_map(item).find(|shown| shown["id"].as_str() == Some(id))
    }

    /// Whether `id` may be approved with `digest`, the digest of the request as the window showed it.
    pub fn allows(&self, id: &str, digest: &str) -> Allowed {
        match self.shown(id) {
            None => Allowed::Gone,
            Some(_) if !self.given.contains_key(id) => Allowed::Gone,
            Some(shown) if shown["digest"].as_str() != Some(digest) => Allowed::Changed,
            Some(shown) if shown["canApprove"] != Value::Bool(true) => Allowed::Inexact,
            Some(_) => Allowed::Yes,
        }
    }

    /// Notes what an approval of `id` came to: the request is gone once approved, shown again marked when it changed,
    /// or marked with the daemon's reason.
    fn settle(&mut self, id: &str, outcome: &Outcome, note: String) {
        match outcome {
            Outcome::Approved => {
                self.changed.remove(id);
                self.refused.remove(id);
                self.note = Some(note);
            }
            Outcome::Changed => {
                self.changed.insert(id.to_string());
                self.refused.remove(id);
            }
            Outcome::Refused(why) => {
                self.refused.insert(id.to_string(), why.clone());
            }
        }
    }
}

/// What the bridge's answer to Approve came to, given the list read right after it. A refusal (`{ ok: false }`) is a
/// change only when the daemon said 409 and the list now gives the request another digest than the one sent: the
/// window then shows it again. Any other refusal (a harness not installed, a folder that moved) keeps its reason.
pub fn outcome(id: &str, sent: &str, answer: &Result<Value, String>, relisted: Option<&Value>) -> Outcome {
    let answer = match answer {
        Ok(answer) => answer,
        Err(error) => return Outcome::Refused(crate::text::clean(error, 300)),
    };
    if answer["ok"] == Value::Bool(true) {
        return Outcome::Approved;
    }
    let now = relisted.and_then(|list| list["approvals"].as_array()).and_then(|list| list.iter().find(|a| a["id"].as_str() == Some(id))).and_then(|a| a["digest"].as_str());
    if answer["status"].as_u64() == Some(409) && now.is_some_and(|now| now != sent) {
        return Outcome::Changed;
    }
    Outcome::Refused(crate::text::clean(answer["error"].as_str().unwrap_or("The daemon refused it."), 300))
}

/// The custom-command form's input, checked before it goes to the bridge (the daemon checks it again).
pub fn custom_input(name: &str, command: &str, model: &str) -> Result<(String, String, Option<String>), String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 || !exact(name, 64) {
        return Err("Give the agent a name of 1 to 64 characters, as plain text.".into());
    }
    let command = command.trim();
    if command.is_empty() || command.chars().count() > 2_000 || command.chars().any(char::is_control) {
        return Err("Give the command as one line of at most 2000 characters.".into());
    }
    // A character that hides or reorders text would make the command read otherwise than it runs.
    if command.chars().any(crate::text::invisible) {
        return Err("The command holds an invisible character (a bidi control or zero-width character). Type it again without one.".into());
    }
    if !command.contains("{prompt_file}") {
        return Err("Put {prompt_file} in the command where the prompt file's path goes.".into());
    }
    let model = model.trim();
    let model_ok = |m: &str| {
        let mut chars = m.chars();
        m.len() <= 100 && chars.next().is_some_and(|c| c.is_ascii_alphanumeric()) && chars.all(|c| c.is_ascii_alphanumeric() || "_.:/@-".contains(c))
    };
    if !model.is_empty() && !model_ok(model) {
        return Err("Leave the model empty, or give a model id such as sonnet.".into());
    }
    Ok((name.to_string(), command.to_string(), (!model.is_empty()).then(|| model.to_string())))
}

/// What the tray's item says: the count of what waits, when anything does.
pub fn tray_label(waiting: u64) -> String {
    if waiting == 0 { "Approvals…".into() } else { format!("Approvals ({waiting} waiting)…") }
}

/// A daemon started without the app's approval routes answers 404: say how to get them.
fn read_problem(error: &str) -> String {
    if error.contains("Unknown local endpoint") {
        "The running daemon was started without the app's approvals. Stop the daemon from the tray, then start it again.".into()
    } else {
        crate::text::clean(error, 160)
    }
}

/// Only the Approvals window may use these commands; any other window is refused.
pub fn ours_label(label: &str) -> Result<(), String> {
    if label == WINDOW { Ok(()) } else { Err("Not available here.".into()) }
}

// The window and the bridge.

fn state(app: &AppHandle) -> std::sync::MutexGuard<'_, Approving> {
    crate::lock(app.state::<Mutex<Approving>>().inner())
}

#[cfg(debug_assertions)]
fn trace(what: &str) {
    eprintln!("approvals: {what}");
}
#[cfg(not(debug_assertions))]
fn trace(_: &str) {}

/// Runs one bridge command for the app, with its proof on stdin, then `more` (a line each).
fn app_cli(app: &AppHandle, args: &[&str], more: &[&str]) -> Result<Value, String> {
    let proof = crate::pair::app_proof()?;
    let mut input = format!("{proof}\n");
    for line in more {
        input.push_str(line);
        input.push('\n');
    }
    crate::bridge::cli_with_input(&*crate::bridge(app)?, args, Some(input.as_bytes()))
}

/// Reads the list once: whether it could be read. The tray's count follows it.
fn read(app: &AppHandle) -> bool {
    let result = app_cli(app, &["agent", "approvals"], &[]);
    let waiting = {
        let mut approving = state(app);
        match result {
            Ok(list) => {
                let waiting = list["approvals"].as_array().map(|list| list.len() as u64);
                approving.listed(list);
                if !approving.busy {
                    approving.problem = None;
                }
                waiting
            }
            Err(error) => {
                approving.problem = Some(read_problem(&error));
                None
            }
        }
    };
    if let Some(waiting) = waiting {
        crate::show_approvals(app, waiting);
    }
    waiting.is_some()
}

/// Shows the window, and reads the list again every `REFRESH` while it is open.
pub fn show(app: &AppHandle) {
    let window = match app.get_webview_window(WINDOW) {
        Some(window) => window,
        None => match WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("approvals.html".into())).title("Meshrooms: approvals").inner_size(600.0, 640.0).build() {
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
        let mut approving = state(app);
        approving.open = true;
        approving.generation += 1;
        approving.generation
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
    let approving = state(app);
    approving.open && approving.generation == generation
}

/// The window closed: its refresher stops, and what it was given is forgotten (the next show starts afresh).
pub fn closed(app: &AppHandle) {
    let mut approving = state(app);
    approving.open = false;
    approving.given.clear();
    approving.changed.clear();
    approving.refused.clear();
    approving.note = None;
    approving.custom_problem = None;
    approving.custom = None;
}

/// Takes the one turn for an answer, or says why not.
fn begin(approving: &mut Approving) -> Result<(), String> {
    if approving.busy {
        return Err("Another answer is under way. Wait a moment.".into());
    }
    approving.busy = true;
    approving.problem = None;
    approving.note = None;
    Ok(())
}

/// Approve, for the request `id` as the window showed it (`digest`), off the window's thread; the list is read again
/// after. A request that changed since is shown again, never approved.
pub fn approve(app: &AppHandle, id: String, digest: String) -> Result<(), String> {
    let note = {
        let mut approving = state(app);
        match approving.allows(&id, &digest) {
            Allowed::Yes => {}
            Allowed::Changed => {
                trace("approve refused here: the request changed since it was shown");
                approving.changed.insert(id);
                return Ok(());
            }
            Allowed::Gone => return Err("That request is not waiting any more.".into()),
            Allowed::Inexact => return Err("This request can't be shown exactly as it is, so it can't be approved here. Reject it.".into()),
        }
        let shown = approving.shown(&id).unwrap_or(Value::Null);
        begin(&mut approving)?;
        let row = |label: &str| shown["rows"].as_array().and_then(|rows| rows.iter().find(|r| r["label"] == label)).and_then(|r| r["value"].as_str()).unwrap_or_default().to_string();
        if shown["kind"] == "identity" {
            format!("Made {}. Put it into a room from the Meshrooms page.", row("Name"))
        } else {
            format!("Bound {} in {} to that session, working in {}.", row("Agent"), row("Room"), row("Working folder"))
        }
    };
    trace("approving");
    let app = app.clone();
    std::thread::spawn(move || {
        let answer = app_cli(&app, &["agent", "approve", "--id", &id, "--digest", &digest], &[]);
        let relisted = app_cli(&app, &["agent", "approvals"], &[]).ok();
        let result = outcome(&id, &digest, &answer, relisted.as_ref());
        trace(&format!("approve came to {result:?}"));
        {
            let mut approving = state(&app);
            approving.busy = false;
            if let Some(list) = relisted {
                approving.list = Some(list);
            }
            approving.settle(&id, &result, note);
        }
        let _ = read(&app);
    });
    Ok(())
}

/// Reject: one click, for a request the window showed; nothing is made or bound.
pub fn reject(app: &AppHandle, id: String) -> Result<(), String> {
    {
        let mut approving = state(app);
        if approving.shown(&id).is_none() || !approving.given.contains_key(&id) {
            return Err("That request is not waiting any more.".into());
        }
        begin(&mut approving)?;
    }
    trace("rejecting");
    let app = app.clone();
    std::thread::spawn(move || {
        let answer = app_cli(&app, &["agent", "reject", "--id", &id], &[]);
        // The list as it stands after the answer, kept before the note, so the note stays until another request comes or goes.
        let relisted = app_cli(&app, &["agent", "approvals"], &[]).ok();
        {
            let mut approving = state(&app);
            approving.busy = false;
            if let Some(list) = relisted {
                approving.list = Some(list);
            }
            match &answer {
                Ok(answer) if answer["ok"] == Value::Bool(true) => {
                    approving.changed.remove(&id);
                    approving.refused.remove(&id);
                    approving.note = Some("Rejected. Nothing was made or bound.".into());
                }
                Ok(answer) => approving.problem = Some(crate::text::clean(answer["error"].as_str().unwrap_or("The daemon refused it."), 160)),
                Err(error) => approving.problem = Some(crate::text::clean(error, 160)),
            }
        }
        trace(if matches!(&answer, Ok(a) if a["ok"] == Value::Bool(true)) { "rejected" } else { "reject failed" });
        let _ = read(&app);
    });
    Ok(())
}

/// "Review this agent" in the custom-command form, off the window's thread: the bridge reads the command back as it
/// would run (`agent custom --check`, which makes nothing), and the window shows that for confirmation.
pub fn check_custom(app: &AppHandle, name: String, command: String, model: String) -> Result<(), String> {
    let sent = match custom_input(&name, &command, &model) {
        Ok(input) => input,
        Err(problem) => {
            let mut approving = state(app);
            approving.custom_problem = Some(problem.clone());
            approving.custom = None;
            return Err(problem);
        }
    };
    {
        let mut approving = state(app);
        begin(&mut approving)?;
        approving.custom_problem = None;
        approving.custom = None;
    }
    trace("reading a custom command back");
    let app = app.clone();
    std::thread::spawn(move || {
        let mut args = vec!["agent", "custom", "--check", "--name", sent.0.as_str()];
        if let Some(model) = &sent.2 {
            args.extend(["--model", model.as_str()]);
        }
        let answer = app_cli(&app, &args, &[sent.1.as_str()]);
        let mut approving = state(&app);
        approving.busy = false;
        match answer.and_then(|answer| CustomPreview::of(&answer, &sent)) {
            Ok(preview) => {
                trace("custom command shown for confirmation");
                approving.custom = Some(preview);
            }
            Err(error) => approving.custom_problem = Some(crate::text::clean(&error, 300)),
        }
    });
    Ok(())
}

/// "Make this agent" on the confirmation: makes exactly the agent the window showed (`command`: the command it showed,
/// which must be the one read back), off the window's thread.
pub fn make_custom(app: &AppHandle, command: String) -> Result<(), String> {
    let preview = {
        let mut approving = state(app);
        let preview = approving.custom.clone().filter(|p| p.command == command).ok_or("That command is not the one shown. Review it again.")?;
        begin(&mut approving)?;
        preview
    };
    trace("making a custom-command agent");
    let app = app.clone();
    std::thread::spawn(move || {
        let mut args = vec!["agent", "custom", "--name", preview.name.as_str()];
        if let Some(model) = &preview.model {
            args.extend(["--model", model.as_str()]);
        }
        let answer = app_cli(&app, &args, &[preview.command.as_str()]);
        let mut approving = state(&app);
        approving.busy = false;
        match &answer {
            Ok(answer) if answer["ok"] == Value::Bool(true) => {
                approving.made += 1;
                approving.custom = None;
                approving.note = Some(made_note(&preview));
                trace("made");
            }
            Ok(answer) => approving.custom_problem = Some(crate::text::clean(answer["error"].as_str().unwrap_or("The daemon refused it."), 300)),
            Err(error) => approving.custom_problem = Some(crate::text::clean(error, 300)),
        }
    });
    Ok(())
}

/// What the window says once a custom-command agent is made: its name and the command it runs.
pub fn made_note(preview: &CustomPreview) -> String {
    format!("Made {}, a custom-command agent. Each wake runs: {}. Put it into a room from the Meshrooms page.", preview.name, preview.command)
}

/// "Edit" on the confirmation: back to the form, nothing made.
pub fn edit_custom(app: &AppHandle) {
    state(app).custom = None;
}

fn ours(window: &WebviewWindow) -> Result<(), String> {
    ours_label(window.label())
}

#[tauri::command]
pub fn approvals_view(window: WebviewWindow) -> Result<Value, String> {
    ours(&window)?;
    Ok(state(window.app_handle()).view())
}

/// `digest`: the digest of the request as the window showed it.
#[tauri::command]
pub fn approvals_approve(window: WebviewWindow, id: String, digest: String) -> Result<(), String> {
    ours(&window)?;
    approve(window.app_handle(), id, digest)
}

#[tauri::command]
pub fn approvals_reject(window: WebviewWindow, id: String) -> Result<(), String> {
    ours(&window)?;
    reject(window.app_handle(), id)
}

#[tauri::command]
pub fn approvals_custom_check(window: WebviewWindow, name: String, command: String, model: String) -> Result<(), String> {
    ours(&window)?;
    check_custom(window.app_handle(), name, command, model)
}

/// `command`: the command the confirmation showed.
#[tauri::command]
pub fn approvals_custom_make(window: WebviewWindow, command: String) -> Result<(), String> {
    ours(&window)?;
    make_custom(window.app_handle(), command)
}

#[tauri::command]
pub fn approvals_custom_edit(window: WebviewWindow) -> Result<(), String> {
    ours(&window)?;
    edit_custom(window.app_handle());
    Ok(())
}

#[tauri::command]
pub fn approvals_close(window: WebviewWindow) -> Result<(), String> {
    ours(&window)?;
    closed(window.app_handle());
    let _ = window.close();
    Ok(())
}

/// Development builds: what the window shows now.
#[cfg(debug_assertions)]
pub fn dev_view(app: &AppHandle) -> Value {
    state(app).view()
}

/// Development builds: Approve `<id>:<digest>` as the button does (the digest the window showed), Reject `<id>`, fill
/// the custom-command form from a JSON file (`{ name, command, model? }`) and press Review, or press Make this agent on
/// the confirmation it shows: the window's commands without a mouse, through the same code.
#[cfg(debug_assertions)]
pub fn dev_approve(app: &AppHandle, which: &str) -> Result<(), String> {
    let (id, digest) = which.split_once(':').ok_or("Give <id>:<digest>.")?;
    approve(app, id.to_string(), digest.to_string())
}
#[cfg(debug_assertions)]
pub fn dev_reject(app: &AppHandle, id: &str) -> Result<(), String> {
    reject(app, id.to_string())
}
#[cfg(debug_assertions)]
pub fn dev_custom_check(app: &AppHandle, file: &str) -> Result<(), String> {
    let input: Value = serde_json::from_str(&std::fs::read_to_string(file).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    let text = |key: &str| input[key].as_str().unwrap_or_default().to_string();
    check_custom(app, text("name"), text("command"), text("model"))
}
#[cfg(debug_assertions)]
pub fn dev_custom_make(app: &AppHandle) -> Result<(), String> {
    let shown = state(app).custom.clone().ok_or("No custom-command agent is shown for confirmation.")?;
    make_custom(app, shown.command)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "00000000-0000-4000-8000-0000000000a1";
    const BIND: &str = "00000000-0000-4000-8000-0000000000b2";
    const AGENT: &str = "00000000-0000-4000-8000-0000000000c3";
    const ROOM: &str = "00000000-0000-4000-8000-0000000000d4";
    const D1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const D2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn identity(digest: &str, model: &str) -> Value {
        json!({ "id": ID, "kind": "identity", "name": "Elm", "harness": "claude", "model": model, "requestedAt": "2026-10-05T06:40:55.687Z",
            "expiresAt": "2026-10-06T06:40:55.687Z", "digest": digest })
    }
    fn bind(cwd: Value) -> Value {
        json!({ "id": BIND, "kind": "bind-existing", "identityId": AGENT, "roomId": ROOM,
            "harness": "claude", "session": "5f0c8a43-0000-4000-8000-000000000001", "title": "Synthetic design review", "folder": "design-work", "cwd": cwd,
            "requestedAt": "2026-10-05T06:40:55.687Z", "expiresAt": "2026-10-06T06:40:55.687Z", "identityName": "Ash", "identityModel": "sonnet", "roomTitle": "Agents check", "digest": D2 })
    }
    fn approving(list: Vec<Value>) -> Approving {
        Approving { list: Some(json!({ "approvals": list })), ..Approving::default() }
    }
    fn rows(item: &Value) -> Vec<(String, String)> {
        item["rows"].as_array().unwrap().iter().map(|r| (r["label"].as_str().unwrap().to_string(), r["value"].as_str().unwrap().to_string())).collect()
    }
    fn row(item: &Value, label: &str) -> String {
        rows(item).into_iter().find(|(l, _)| l == label).map(|(_, v)| v).unwrap_or_else(|| panic!("no row {label}"))
    }

    #[test]
    fn only_the_approvals_window_may_use_its_commands() {
        assert!(ours_label(WINDOW).is_ok());
        for other in ["main", "pair", "join", "review", "notice-1", "approvals2", ""] {
            assert!(ours_label(other).is_err(), "{other}");
        }
    }

    #[test]
    fn its_capability_grants_its_commands_to_its_window_only() {
        let capability: Value = serde_json::from_str(include_str!("../capabilities/approvals.json")).unwrap();
        assert_eq!(capability["windows"], json!(["approvals"]));
        assert_eq!(capability["permissions"], json!(["allow-approvals-view", "allow-approvals-approve", "allow-approvals-reject", "allow-approvals-custom-check",
            "allow-approvals-custom-make", "allow-approvals-custom-edit", "allow-approvals-close"]));
        // No other window's capability grants any of them.
        for other in [include_str!("../capabilities/pair.json"), include_str!("../capabilities/join.json"), include_str!("../capabilities/review.json")] {
            assert!(!other.contains("approvals"), "{other}");
        }
    }

    #[test]
    fn an_identity_request_shows_every_stored_field() {
        let shown = item(&identity(D1, "sonnet")).unwrap();
        assert_eq!(rows(&shown), vec![("Name".into(), "Elm".into()), ("Harness".into(), "Claude Code".into()), ("Model".into(), "sonnet".into())]);
        assert_eq!(shown["canApprove"], true);
        assert_eq!(shown["asked"], "2026-10-05 06:40 UTC");
        let mut plain = identity(D1, "x");
        plain.as_object_mut().unwrap().remove("model");
        assert_eq!(row(&item(&plain).unwrap(), "Model"), "The harness's default");
    }

    #[test]
    fn who_filed_a_request_is_never_the_requests_own_word() {
        // Whatever an entry says of itself, the window says what the daemon knows: that it doesn't record who.
        for mut entry in [identity(D1, "sonnet"), bind(json!("D:\\Projects\\design-work"))] {
            for key in ["who", "filedBy", "requestedBy", "by", "provenance"] {
                entry[key] = json!("Your administrator (verified)");
            }
            let shown = item(&entry).unwrap();
            let who = shown["who"].as_str().unwrap();
            assert!(who == IDENTITY_PROVENANCE || who == BIND_PROVENANCE);
            assert!(who.contains("Which one is not recorded") && !shown.to_string().contains("administrator"), "{shown}");
        }
    }

    #[test]
    fn a_bind_request_shows_what_it_applies_the_ids_beside_their_labels_and_the_full_working_folder() {
        let folder = "D:\\Projects\\work\\design-work";
        let shown = item(&bind(json!(folder))).unwrap();
        assert_eq!(rows(&shown), vec![
            ("Agent".into(), "Ash".into()), ("Agent id".into(), AGENT.into()), ("Model".into(), "sonnet".into()), ("Room".into(), "Agents check".into()),
            ("Room id".into(), ROOM.into()), ("Harness".into(), "Claude Code".into()), ("Session".into(), "Synthetic design review".into()),
            ("Folder label".into(), "design-work".into()), ("Working folder".into(), folder.into()), ("Session id".into(), "5f0c8a43-0000-4000-8000-000000000001".into()),
        ]);
        assert_eq!(shown["canApprove"], true);
        // A long folder is shown whole, never cut.
        let long = format!("/srv/projects/{}", "deep/".repeat(200));
        let long = long.trim_end_matches('/');
        assert_eq!(row(&item(&bind(json!(long))).unwrap(), "Working folder"), long);
        // Codex works in the room's own folder.
        let mut codex = bind(Value::Null);
        codex["harness"] = json!("codex");
        assert_eq!(row(&item(&codex).unwrap(), "Working folder"), "The room's own folder (Codex always works there)");
        // A folder for another harness must be named.
        assert_eq!(item(&bind(Value::Null)).unwrap()["canApprove"], false);
        // An identity without a model of its own: null, shown as the harness's default.
        let mut defaulted = bind(json!(folder));
        defaulted["identityModel"] = Value::Null;
        assert_eq!(row(&item(&defaulted).unwrap(), "Model"), "The harness's default");
        assert_eq!(item(&defaulted).unwrap()["canApprove"], true);
        // A label the daemon didn't give (an older daemon, whose digest doesn't cover it) is no label to approve by.
        for key in ["identityName", "identityModel", "roomTitle"] {
            let mut missing = bind(json!(folder));
            missing.as_object_mut().unwrap().remove(key);
            assert_eq!(item(&missing).unwrap()["canApprove"], false, "{key}");
        }
    }

    #[test]
    fn what_the_window_cant_show_exactly_is_spelled_out_and_can_only_be_rejected() {
        // An invisible character in the working folder: shown escaped, never cleaned away.
        let shown = item(&bind(json!("C:\\work\u{202E}gnp.exe"))).unwrap();
        assert_eq!(shown["canApprove"], false);
        assert_eq!(row(&shown, "Working folder"), "C:\\work\\u{202E}gnp.exe");
        for (folder, spelled) in [("C:\\two  spaces", "C:\\two\\u{0020}\\u{0020}spaces"), (" C:\\lead", "\\u{0020}C:\\lead"), ("C:\\tab\there", "C:\\tab\\u{0009}here"),
            ("C:\\zero\u{200B}width", "C:\\zero\\u{200B}width")] {
            let shown = item(&bind(json!(folder))).unwrap();
            assert_eq!(shown["canApprove"], false, "{folder:?}");
            assert_eq!(row(&shown, "Working folder"), spelled);
        }
        // In the name an identity request would make, or the agent's name on a bind.
        let mut odd = identity(D1, "sonnet");
        odd["name"] = json!("Elm\u{200B}");
        let shown = item(&odd).unwrap();
        assert_eq!(shown["canApprove"], false);
        assert_eq!(row(&shown, "Name"), "Elm\\u{200B}");
        let mut a = approving(vec![odd]);
        a.view();
        assert_eq!(a.allows(ID, D1), Allowed::Inexact);
        let mut named = bind(json!("D:\\work"));
        named["identityName"] = json!("Ash\u{202E}");
        assert_eq!(item(&named).unwrap()["canApprove"], false);
        assert_eq!(row(&item(&named).unwrap(), "Agent"), "Ash\\u{202E}");
        // Not a request at all: skipped.
        for bad in [json!({ "id": ID, "kind": "identity" }), json!({ "id": "x", "kind": "identity", "digest": D1 }), json!({ "id": ID, "kind": "other", "digest": D1 })] {
            assert_eq!(item(&bad), None, "{bad}");
        }
    }

    #[test]
    fn characters_that_render_blank_are_written_out_and_reject_only_in_names_and_folders() {
        // Each class of Default_Ignorable_Code_Point, and the blank fillers: CGJ, Hangul fillers, Khmer inherent vowels,
        // blank Braille, soft hyphen, the reserved specials, shorthand and musical format controls, reserved tags.
        for c in ['\u{034F}', '\u{115F}', '\u{1160}', '\u{3164}', '\u{FFA0}', '\u{17B4}', '\u{17B5}', '\u{2800}', '\u{00AD}', '\u{2065}', '\u{FFF0}',
            '\u{1BCA0}', '\u{1D173}', '\u{E0080}'] {
            let code = format!("\\u{{{:04X}}}", c as u32);
            let shown = item(&bind(json!(format!("/srv/work/proj{c}ect")))).unwrap();
            assert_eq!(shown["canApprove"], false, "{code} in a folder");
            assert_eq!(row(&shown, "Working folder"), format!("/srv/work/proj{code}ect"));
            let mut named = identity(D1, "sonnet");
            named["name"] = json!(format!("El{c}m"));
            let shown = item(&named).unwrap();
            assert_eq!(shown["canApprove"], false, "{code} in a name");
            assert_eq!(row(&shown, "Name"), format!("El{code}m"));
        }
    }

    #[test]
    fn names_and_folders_with_non_ascii_characters_are_marked() {
        let marked = |item: &Value, label: &str| item["rows"].as_array().unwrap().iter().find(|r| r["label"] == label).unwrap()["nonAscii"].clone();
        let mut cyrillic = identity(D1, "sonnet");
        cyrillic["name"] = json!("Elм");
        let shown = item(&cyrillic).unwrap();
        assert_eq!(shown["canApprove"], true, "a visible letter can be approved, marked");
        assert_eq!(marked(&shown, "Name"), true);
        assert_eq!(marked(&shown, "Model"), false);
        assert_eq!(marked(&item(&identity(D1, "sonnet")).unwrap(), "Name"), false);
        let shown = item(&bind(json!("D:\\Prоjects\\work"))).unwrap();
        assert_eq!((marked(&shown, "Working folder"), marked(&shown, "Agent")), (json!(true), json!(false)));
        let preview = CustomPreview { name: "Oak".into(), command: "аgent {prompt_file}".into(), program: "аgent".into(), args: vec!["{prompt_file}".into()], model: None };
        assert_eq!(preview.view()["nonAscii"], json!({ "name": false, "command": true }));
    }

    #[test]
    fn what_the_last_answer_did_is_not_said_once_the_requests_change() {
        let mut a = approving(vec![identity(D1, "sonnet")]);
        a.note = Some("Made Fern.".into());
        a.listed(json!({ "approvals": [identity(D1, "sonnet")] }));
        assert_eq!(a.note.as_deref(), Some("Made Fern."), "the same requests: the note stays");
        a.listed(json!({ "approvals": [identity(D1, "sonnet"), bind(json!("D:\\work"))] }));
        assert_eq!(a.note, None, "a new request: the note goes");
        a.note = Some("Rejected.".into());
        a.listed(json!({ "approvals": [] }));
        assert_eq!(a.note, None, "one gone: the note goes");
    }

    #[test]
    fn approve_sends_back_the_digest_the_window_showed_and_nothing_else() {
        let mut a = approving(vec![identity(D1, "sonnet")]);
        // Nothing approved that the window was never given.
        assert_eq!(a.allows(ID, D1), Allowed::Gone);
        let view = a.view();
        let shown = &view["items"][0];
        assert_eq!(shown["digest"], D1);
        // The round trip: the digest the view gave is the one that may be sent.
        assert_eq!(a.allows(ID, shown["digest"].as_str().unwrap()), Allowed::Yes);
        assert_eq!(a.allows(ID, D2), Allowed::Changed);
        assert_eq!(a.allows(BIND, D1), Allowed::Gone);
        // A field changes after the window showed it: the view marks it, and the old digest is no longer good.
        a.list = Some(json!({ "approvals": [identity(D2, "opus")] }));
        assert_eq!(a.allows(ID, D1), Allowed::Changed, "stale before the window even reads it again");
        let view = a.view();
        assert_eq!(view["items"][0]["changed"], CHANGED);
        assert_eq!(row(&view["items"][0], "Model"), "opus");
        assert_eq!(a.allows(ID, D1), Allowed::Changed);
        assert_eq!(a.allows(ID, D2), Allowed::Yes);
    }

    #[test]
    fn a_409_for_a_changed_request_shows_it_again_marked_and_approves_nothing() {
        let refused = Ok(json!({ "ok": false, "status": 409, "error": "This request changed since it was shown, or the approval named no digest. Look at it again before approving." }));
        let relisted = json!({ "approvals": [identity(D2, "opus")] });
        assert_eq!(outcome(ID, D1, &refused, Some(&relisted)), Outcome::Changed);
        let mut a = approving(vec![identity(D1, "sonnet")]);
        a.view();
        a.list = Some(relisted.clone());
        a.settle(ID, &Outcome::Changed, "Made Elm.".into());
        let view = a.view();
        assert_eq!(view["items"][0]["changed"], CHANGED);
        assert_eq!(view["note"], Value::Null, "nothing was made");
        // The person checks it again; only a deliberate Approve with the new digest goes on.
        assert_eq!(a.allows(ID, D2), Allowed::Yes);
        // A 409 for a request that did not change (its harness isn't installed) keeps the daemon's reason instead.
        let missing = Ok(json!({ "ok": false, "status": 409, "error": "Hermes is not installed on this machine, so this agent was not made." }));
        assert_eq!(outcome(ID, D2, &missing, Some(&relisted)), Outcome::Refused("Hermes is not installed on this machine, so this agent was not made.".into()));
        // A request gone meanwhile, or a list that couldn't be read: the reason, never "changed".
        assert!(matches!(outcome(ID, D1, &refused, Some(&json!({ "approvals": [] }))), Outcome::Refused(_)));
        assert!(matches!(outcome(ID, D1, &refused, None), Outcome::Refused(_)));
        assert!(matches!(outcome(ID, D1, &Err("The bridge failed.".into()), Some(&relisted)), Outcome::Refused(_)));
        assert_eq!(outcome(ID, D1, &Ok(json!({ "ok": true, "approved": true })), None), Outcome::Approved);
        // Refused: the reason stays on the request until it changes.
        a.settle(ID, &Outcome::Refused("Not installed.".into()), String::new());
        assert_eq!(a.view()["items"][0]["refused"], "Not installed.");
    }

    #[test]
    fn the_custom_command_form_is_checked_before_the_bridge() {
        assert_eq!(custom_input(" Oak ", "my-agent --prompt-file {prompt_file}", ""), Ok(("Oak".into(), "my-agent --prompt-file {prompt_file}".into(), None)));
        assert_eq!(custom_input("Oak", "\"C:\\Program Files\\x.exe\" {prompt_file}", "sonnet").unwrap().2, Some("sonnet".into()));
        for (name, command, model) in [("", "x {prompt_file}", ""), ("Oak", "x", ""), ("Oak", "x {prompt_file}\nrm", ""), ("Oak", "x {prompt_file}", "-flag"),
            ("O\u{202E}k", "x {prompt_file}", ""), ("Oak", "safe\u{202E}exe.x {prompt_file}", ""), ("Oak", "x\u{200B} {prompt_file}", "")] {
            assert!(custom_input(name, command, model).is_err(), "{name:?} {command:?} {model:?}");
        }
    }

    #[test]
    fn a_custom_command_is_made_only_as_read_back_and_shown_and_the_note_names_it() {
        let sent = ("Oak".to_string(), "\"C:/Program Files/run.exe\" --prompt-file {prompt_file}".to_string(), None);
        let answer = json!({ "ok": true, "name": "Oak", "command": sent.1, "program": "C:/Program Files/run.exe", "args": ["--prompt-file", "{prompt_file}"], "model": null });
        let preview = CustomPreview::of(&answer, &sent).unwrap();
        assert_eq!(preview.view(), json!({ "name": "Oak", "command": sent.1, "program": "C:/Program Files/run.exe", "args": ["--prompt-file", "{prompt_file}"], "model": null,
            "nonAscii": { "name": false, "command": false } }));
        assert_eq!(made_note(&preview), format!("Made Oak, a custom-command agent. Each wake runs: {}. Put it into a room from the Meshrooms page.", sent.1));
        // Read back as anything else than what was typed (another command, name or model), or with a part that can't be
        // shown exactly: nothing to confirm.
        for (key, value) in [("command", json!("other {prompt_file}")), ("name", json!("Ash")), ("model", json!("opus")), ("program", json!("run\u{202E}exe")),
            ("args", json!(["--prompt-file", 7])), ("program", json!(""))] {
            let mut changed = answer.clone();
            changed[key] = value;
            assert!(CustomPreview::of(&changed, &sent).is_err(), "{key}");
        }
        assert!(CustomPreview::of(&json!({ "ok": false, "status": 400, "error": "The --command template has an unclosed quote." }), &sent).unwrap_err().contains("unclosed"));
        // Make takes only the command the confirmation showed.
        let a = Approving { custom: Some(preview.clone()), ..Approving::default() };
        assert_eq!(a.custom.clone().filter(|p| p.command == sent.1), Some(preview));
        assert_eq!(a.custom.clone().filter(|p| p.command == "other {prompt_file}"), None);
    }

    #[test]
    fn the_tray_counts_what_waits() {
        assert_eq!(tray_label(0), "Approvals…");
        assert_eq!(tray_label(2), "Approvals (2 waiting)…");
        assert!(read_problem("Unknown local endpoint.").contains("without the app's approvals"));
    }
}
