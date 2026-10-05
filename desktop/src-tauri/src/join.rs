//! Joining a room from a meshrooms://join link (links.rs; internal/docs/design/desktop-first.md, "Join links open the
//! app"). The hosted room page offers *Open in Meshrooms* once its browser has paired; the link names a room service
//! (origin) and a room, nothing else, and anything can fire one, so nothing happens without the person:
//!
//! - A room this computer is already in opens at once, in the localhost UI (the tray's Open Meshrooms, at the room).
//! - With no paired person, the window says to pair this computer first, and can open the room in the browser instead.
//! - A link to another room service than the paired one is refused: one person per app (pair.rs).
//! - Otherwise the window words the link as a claim, with the room's public title and its origin as plain text, and only
//!   Join runs `person join`, with the app's proof on stdin (the same gate as `person pair`). The person's name is the
//!   paired one (pairing.json). The window then follows `person rooms` until the host lets this computer in, and opens
//!   the room.
//!
//! One join waits at a time; a second link is refused while it does. A join waits 15 minutes at most, for the Join press
//! and then for the host (whose request expires sooner); closing the window ends it. Since any page can fire links in a
//! loop, a room that opened stays "busy" for `OPEN_COOLDOWN`, and an open never queues behind another: a flood of links
//! opens at most one tab per cooldown, so it can't fill the local API's ticket table or the app's work queue.

use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The join window's label: commands answer only to it.
pub const WINDOW: &str = "join";
pub const PENDING_FOR: Duration = Duration::from_secs(15 * 60);
/// How often `person rooms` is read while the host decides.
const PROGRESS_EVERY: Duration = Duration::from_secs(2);
/// After a room opens, further links are refused for this long.
pub const OPEN_COOLDOWN: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stage {
    /// Reading this computer's person (`person status`, `person rooms`).
    Checking,
    /// No paired person: pair this computer first.
    NotPaired,
    /// Paired with someone at another room service: refused.
    OtherService { name: String, origin: String },
    /// The room's title is read (or could not be), then Join or Cancel.
    Confirm,
    /// `person join` runs.
    Sending,
    /// Asked: the host decides.
    Waiting,
    /// In the room: the localhost UI opens at it.
    Done,
    Failed(String),
}

/// What this computer's person says about a link's room: how the link is handled.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    /// Already in it: open it.
    Open,
    /// Asked already, and the host hasn't decided: follow it.
    Wait,
    NotPaired,
    OtherService { name: String, origin: String },
    /// Paired, not in it: ask the person, as `name`.
    Ask { name: String },
    Refuse(String),
}

/// `person status` and `person rooms`, for the room `room` at `origin`. Being in the room wins over everything else; a
/// room on the list through another origin, or closed, is refused; then pairing decides.
pub fn classify(status: &Value, rooms: &Value, origin: &str, room: &str) -> Route {
    let listed = rooms.as_array().and_then(|rooms| rooms.iter().find(|row| row["roomId"].as_str() == Some(room)));
    if let Some(row) = listed {
        if row["origin"].as_str() != Some(origin) {
            return Route::Refuse("This computer is already in that room through another room service.".into());
        }
        match row["state"].as_str() {
            Some("joined") => return Route::Open,
            Some("waiting" | "starting") => return Route::Wait,
            Some("closed") => return Route::Refuse("This room was closed by its host.".into()),
            // Declined, expired or removed: asking again is the person's call.
            _ => {}
        }
    }
    let paired = &status["pairedWith"];
    let (Some(name), Some(paired_origin)) = (paired["name"].as_str(), paired["origin"].as_str()) else {
        return Route::NotPaired;
    };
    if status["initialized"] != Value::Bool(true) {
        return Route::NotPaired;
    }
    let name = crate::text::clean(name, 64);
    if paired_origin != origin {
        return Route::OtherService { name, origin: crate::text::clean(paired_origin, 120) };
    }
    Route::Ask { name }
}

/// One join. Only ids and what the window shows: a join link carries no secret.
pub struct Pending {
    pub id: u64,
    pub origin: String,
    pub room: String,
    name: String,
    title: Option<String>,
    /// Whether the title was read (or could not be): Join shows only then.
    titled: bool,
    opened: Instant,
    pub stage: Stage,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// Another join waits or runs.
    Busy,
    Expired,
    /// Nothing is waiting for this step.
    Nothing,
}

/// What Join hands the bridge: `person join <origin>/r/<room>`, whose stdin the caller fills with the app's proof.
pub struct Handover {
    pub id: u64,
    pub args: Vec<String>,
}

/// The app's one join at a time. Pure: the window and the bridge are wired in below.
#[derive(Default)]
pub struct Joining {
    pending: Option<Pending>,
    next: u64,
    /// When a room last started opening, and whether that open is still under way.
    last_open: Option<Instant>,
    opening: bool,
}

impl Joining {
    fn live(&self, now: Instant) -> bool {
        match &self.pending {
            Some(p) => match p.stage {
                Stage::Checking | Stage::Sending | Stage::Waiting => true,
                Stage::Confirm => now.duration_since(p.opened) < PENDING_FOR,
                // A room that just opened holds off the next link for a while.
                Stage::Done => self.opening || self.last_open.is_some_and(|at| now.duration_since(at) < OPEN_COOLDOWN),
                Stage::NotPaired | Stage::OtherService { .. } | Stage::Failed(_) => false,
            },
            None => false,
        }
    }

    /// A room is about to open. Refused while another open is still under way (it is dropped, never queued).
    pub fn begin_open(&mut self, now: Instant) -> bool {
        if self.opening {
            return false;
        }
        self.opening = true;
        self.last_open = Some(now);
        true
    }

    /// The open finished (or failed).
    pub fn opened(&mut self) {
        self.opening = false;
    }

    /// The join the window shows, for Join to name.
    pub fn current_id(&self) -> Option<u64> {
        self.pending.as_ref().map(|p| p.id)
    }

    /// A join link arrived. Refused while another join waits or runs; one that ended (or expired) is replaced.
    pub fn offer(&mut self, origin: String, room: String, now: Instant) -> Result<u64, Refused> {
        if self.live(now) {
            return Err(Refused::Busy);
        }
        self.next += 1;
        self.pending = Some(Pending { id: self.next, origin, room, name: String::new(), title: None, titled: false, opened: now, stage: Stage::Checking });
        Ok(self.next)
    }

    fn current(&mut self, id: u64) -> Option<&mut Pending> {
        self.pending.as_mut().filter(|p| p.id == id)
    }

    /// What the person's status says. Returns the route, for the caller to act on (open the room, show the window,
    /// fetch the title, follow the request).
    pub fn checked(&mut self, id: u64, route: Route, now: Instant) -> Option<Route> {
        let pending = self.current(id)?;
        if pending.stage != Stage::Checking {
            return None;
        }
        pending.stage = match &route {
            Route::Open => Stage::Done,
            Route::Wait => Stage::Waiting,
            Route::NotPaired => Stage::NotPaired,
            Route::OtherService { name, origin } => Stage::OtherService { name: name.clone(), origin: origin.clone() },
            Route::Ask { name } => {
                pending.name = name.clone();
                // The 15 minutes to press Join start once the window asks.
                pending.opened = now;
                Stage::Confirm
            }
            Route::Refuse(problem) => Stage::Failed(problem.clone()),
        };
        Some(route)
    }

    /// The room's public title (`person titles`), shown before Join.
    pub fn titles(&mut self, id: u64, rows: &Value) {
        let Some(pending) = self.current(id) else { return };
        let room = pending.room.clone();
        let row = rows["rooms"].as_array().and_then(|rows| rows.iter().find(|row| row["roomId"].as_str() == Some(room.as_str())));
        pending.title = row.and_then(|row| row["title"].as_str()).map(|title| crate::text::clean(title, 60)).filter(|title| !title.is_empty());
        pending.titled = true;
    }

    /// Join, for the join `id` the window showed: hands over the bridge command. Never before the title was read for the
    /// person to see, and never for a join the window no longer shows.
    pub fn confirm(&mut self, id: u64, now: Instant) -> Result<Handover, Refused> {
        let expired = match &self.pending {
            Some(p) if p.id == id && p.stage == Stage::Confirm && p.titled => now.duration_since(p.opened) >= PENDING_FOR,
            _ => return Err(Refused::Nothing),
        };
        if expired {
            self.pending = None;
            return Err(Refused::Expired);
        }
        let pending = self.pending.as_mut().expect("checked above");
        pending.stage = Stage::Sending;
        let args = vec!["person".into(), "join".into(), format!("{}/r/{}", pending.origin, pending.room)];
        Ok(Handover { id: pending.id, args })
    }

    /// The bridge's answer to `person join`. Returns whether the room is joined already (the caller opens it).
    pub fn sent(&mut self, id: u64, result: Result<Value, String>) -> bool {
        let Some(pending) = self.current(id) else { return false };
        if pending.stage != Stage::Sending {
            return false;
        }
        pending.stage = match result {
            Ok(answer) => match answer["state"].as_str() {
                Some("joined") => Stage::Done,
                Some("waiting") | None => Stage::Waiting,
                Some(other) => Stage::Failed(ended(other)),
            },
            Err(error) => Stage::Failed(crate::text::clean(&error, 200)),
        };
        pending.stage == Stage::Done
    }

    /// `person rooms`, read while the host decides. Returns whether the room is now joined (the caller opens it).
    pub fn progress(&mut self, id: u64, rooms: &Value) -> bool {
        let Some(pending) = self.current(id) else { return false };
        if pending.stage != Stage::Waiting {
            return false;
        }
        let room = pending.room.clone();
        let state = rooms.as_array().and_then(|rows| rows.iter().find(|row| row["roomId"].as_str() == Some(room.as_str()))).and_then(|row| row["state"].as_str());
        match state {
            Some("joined") => pending.stage = Stage::Done,
            Some(state @ ("declined" | "expired" | "closed" | "removed")) => pending.stage = Stage::Failed(ended(state)),
            _ => {}
        }
        pending.stage == Stage::Done
    }

    /// The host didn't decide in time: the join ends, so a later link isn't refused as busy.
    pub fn timed_out(&mut self, id: u64) {
        let Some(pending) = self.current(id) else { return };
        if matches!(pending.stage, Stage::Sending | Stage::Waiting) {
            pending.stage = Stage::Failed("The host hasn't let you in yet. Open the room's link again later to see whether they have.".into());
        }
    }

    /// Whether `id` still waits for the host (the progress reader stops when it doesn't).
    pub fn waiting(&self, id: u64) -> bool {
        self.pending.as_ref().is_some_and(|p| p.id == id && matches!(p.stage, Stage::Sending | Stage::Waiting))
    }

    /// The window closed or Cancel was pressed: the join ends, whatever its stage, so it never holds off other links. One
    /// already asked for stops being followed; its request stays with the room until the host decides or it expires, and
    /// once admitted the room is on the person's list like any other. A room that just opened keeps its cooldown.
    pub fn cancel(&mut self) {
        if self.pending.as_ref().is_some_and(|p| p.stage != Stage::Done) {
            self.pending = None;
        }
    }

    /// The room page in the browser, for a person who can't (or won't) join from the app: the link's own room, on the
    /// link's own origin (links.rs checked it is HTTPS, or plain HTTP on this machine).
    pub fn browser_page(&self) -> Option<String> {
        let p = self.pending.as_ref()?;
        matches!(p.stage, Stage::NotPaired | Stage::OtherService { .. } | Stage::Confirm | Stage::Failed(_)).then(|| format!("{}/r/{}", p.origin, p.room))
    }

    /// What the window shows: plain text only, which the page renders as text.
    pub fn view(&self, now: Instant) -> Value {
        let Some(p) = &self.pending else { return json!({ "stage": "none" }) };
        let (stage, problem) = match &p.stage {
            Stage::Confirm if now.duration_since(p.opened) >= PENDING_FOR => ("expired", None),
            Stage::Checking => ("checking", None),
            Stage::NotPaired => ("not-paired", None),
            Stage::OtherService { .. } => ("other-service", None),
            Stage::Confirm => ("confirm", None),
            Stage::Sending => ("sending", None),
            Stage::Waiting => ("waiting", None),
            Stage::Done => ("done", None),
            Stage::Failed(problem) => ("failed", Some(problem.clone())),
        };
        let (paired_name, paired_origin) = match &p.stage {
            Stage::OtherService { name, origin } => (Some(name.clone()), Some(origin.clone())),
            _ => (None, None),
        };
        json!({
            "id": p.id, "stage": stage, "origin": p.origin, "name": p.name,
            "title": p.title.clone().unwrap_or_else(|| format!("Room {}", &p.room[..8])), "known": p.title.is_some(), "titled": p.titled,
            "pairedName": paired_name, "pairedOrigin": paired_origin, "problem": problem,
        })
    }
}

/// Why a request ended, as the room's state says.
fn ended(state: &str) -> String {
    match state {
        "declined" => "The host declined the request.".into(),
        "expired" => "The request expired before the host let you in. Open the room's link again to ask again.".into(),
        "closed" => "This room was closed by its host.".into(),
        "removed" => "This computer was removed from the room.".into(),
        other => format!("Not joined ({}).", crate::text::clean(other, 24)),
    }
}

/// Only the join window may use these commands; any other window is refused.
pub fn ours_label(label: &str) -> Result<(), String> {
    if label == WINDOW { Ok(()) } else { Err("Not available here.".into()) }
}

fn refusal(refused: Refused) -> String {
    match refused {
        Refused::Busy => "Another room link is under way. Finish or cancel it in its window first.".into(),
        Refused::Expired => "This link expired. Open it again from your browser.".into(),
        Refused::Nothing => "Nothing is waiting for this.".into(),
    }
}

// The window and the bridge.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

fn state(app: &AppHandle) -> std::sync::MutexGuard<'_, Joining> {
    crate::lock(app.state::<Mutex<Joining>>().inner())
}

#[cfg(debug_assertions)]
fn trace(what: &str) {
    eprintln!("join: {what}");
}
#[cfg(not(debug_assertions))]
fn trace(_: &str) {}

/// A join link arrived (links.rs). The person's status decides what happens; while another join waits, a notice says so.
pub fn open(app: &AppHandle, origin: String, room: String) {
    let offered = state(app).offer(origin.clone(), room.clone(), Instant::now());
    let id = match offered {
        Ok(id) => id,
        Err(_) => {
            trace("refused a second join while one is pending");
            // At most one notice per cooldown: a page firing links in a loop must not keep taking the focus.
            if crate::links::notice_limited(app, "Another room link is already waiting or just opened. Finish or cancel it in its window first; this link was ignored.") {
                if let Some(window) = app.get_webview_window(WINDOW) {
                    let _ = window.set_focus();
                }
            }
            return;
        }
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let route = match (crate::cli(&app, &["person", "status"]), crate::cli(&app, &["person", "rooms"])) {
            (Ok(status), Ok(rooms)) => classify(&status, &rooms, &origin, &room),
            (Err(error), _) | (_, Err(error)) => Route::Refuse(format!("Meshrooms could not read this computer's person: {}", crate::text::clean(&error, 120))),
        };
        trace(&format!("{route:?}"));
        // Bound first: a guard in the match itself would hold the state while the window opens and asks for its view.
        let routed = state(&app).checked(id, route, Instant::now());
        match routed {
            Some(Route::Open) => {
                // Already in the room: no window, the room opens.
                open_room(&app, room);
            }
            Some(route @ (Route::Wait | Route::Ask { .. })) => {
                show(&app);
                // Titles that can't be read show as unavailable: the origin still names where the room is.
                let rows = crate::cli(&app, &["person", "titles", "--origin", &origin, "--rooms", &room]).unwrap_or_else(|_| json!({}));
                state(&app).titles(id, &rows);
                if route == Route::Wait {
                    trace("already asked; waiting for the host");
                    follow(&app, id, room);
                } else {
                    trace("title read; asking");
                }
            }
            Some(_) => show(&app),
            None => {}
        }
    });
}

fn show(app: &AppHandle) {
    let window = match app.get_webview_window(WINDOW) {
        Some(window) => window,
        None => match WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("join.html".into()))
            .title("Meshrooms: join a room")
            .inner_size(520.0, 520.0)
            .build()
        {
            Ok(window) => window,
            Err(_) => return,
        },
    };
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Follows `person rooms` until the host lets this computer in (then opens the room), declines, or the join times out.
fn follow(app: &AppHandle, id: u64, room: String) {
    let until = Instant::now() + PENDING_FOR;
    while Instant::now() < until && state(app).waiting(id) {
        std::thread::sleep(PROGRESS_EVERY);
        if let Ok(rooms) = crate::cli(app, &["person", "rooms"]) {
            if state(app).progress(id, &rooms) {
                trace("admitted; opening the room");
                open_room(app, room);
                return;
            }
        }
    }
    state(app).timed_out(id);
    trace("progress ended");
}

/// Opens the local page at `room`, unless another open is still under way (then this one is dropped).
fn open_room(app: &AppHandle, room: String) {
    if !state(app).begin_open(Instant::now()) {
        trace("an open is under way; this one was dropped");
        return;
    }
    crate::open_meshrooms_then(app, Some(room), |app| state(app).opened());
}

/// The window closed: the join ends (see `Joining::cancel`).
pub fn closed(app: &AppHandle) {
    state(app).cancel();
}

/// Join, pressed in the window for the join `id` it showed (`None`: the one waiting, for the development hook):
/// `person join` with the app's proof on stdin, then the request is followed.
pub fn confirm(app: &AppHandle, id: Option<u64>) -> Result<(), String> {
    let handed = {
        let mut joining = state(app);
        match id.or_else(|| joining.current_id()) {
            Some(id) => joining.confirm(id, Instant::now()),
            None => Err(Refused::Nothing),
        }
    };
    let Handover { id, args } = handed.map_err(refusal)?;
    trace("asking to join");
    let app = app.clone();
    std::thread::spawn(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let result = crate::pair::app_proof().and_then(|proof| {
            crate::bridge(&app).and_then(|bridge| crate::bridge::cli_with_input(&bridge, &refs, Some(format!("{proof}\n").as_bytes())))
        });
        trace(if result.is_ok() { "asked" } else { "join failed" });
        let room = state(&app).pending.as_ref().filter(|p| p.id == id).map(|p| p.room.clone());
        let joined = state(&app).sent(id, result);
        let Some(room) = room else { return };
        if joined {
            open_room(&app, room);
        } else {
            follow(&app, id, room);
        }
    });
    Ok(())
}

/// Open the link's room in the browser instead (not paired, another room service, or the person prefers it).
pub fn browse(app: &AppHandle) -> Result<(), String> {
    let page = state(app).browser_page().ok_or_else(|| refusal(Refused::Nothing))?;
    trace("opening the room in the browser");
    crate::open_external(&page).map_err(|error| format!("Cannot open the room in the browser: {error}"))
}

fn ours(window: &WebviewWindow) -> Result<(), String> {
    ours_label(window.label())
}

#[tauri::command]
pub fn join_view(window: WebviewWindow) -> Result<Value, String> {
    ours(&window)?;
    Ok(state(window.app_handle()).view(Instant::now()))
}

#[tauri::command]
pub fn join_confirm(window: WebviewWindow, id: u64) -> Result<(), String> {
    ours(&window)?;
    confirm(window.app_handle(), Some(id))
}

#[tauri::command]
pub fn join_cancel(window: WebviewWindow) -> Result<(), String> {
    ours(&window)?;
    closed(window.app_handle());
    trace("cancelled");
    let _ = window.close();
    Ok(())
}

#[tauri::command]
pub fn join_browse(window: WebviewWindow) -> Result<(), String> {
    ours(&window)?;
    browse(window.app_handle())?;
    closed(window.app_handle());
    let _ = window.close();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM: &str = "00000000-0000-4000-8000-000000000001";
    const ORIGIN: &str = "https://rooms.example";
    fn paired(origin: &str) -> Value {
        json!({ "initialized": true, "pairedWith": { "name": "Robin\u{202E} Lee", "origin": origin }, "rooms": 1 })
    }
    fn listed(state: &str, origin: &str) -> Value {
        json!([{ "roomId": ROOM, "origin": origin, "state": state, "title": "Launch" }])
    }

    #[test]
    fn the_person_decides_the_route_and_being_in_the_room_wins() {
        let none = json!([]);
        // In the room: open it, paired or not (a room the app created itself has no pairing).
        assert_eq!(classify(&paired(ORIGIN), &listed("joined", ORIGIN), ORIGIN, ROOM), Route::Open);
        assert_eq!(classify(&json!({ "initialized": true, "pairedWith": null }), &listed("joined", ORIGIN), ORIGIN, ROOM), Route::Open);
        assert_eq!(classify(&paired(ORIGIN), &listed("waiting", ORIGIN), ORIGIN, ROOM), Route::Wait);
        assert_eq!(classify(&paired(ORIGIN), &listed("closed", ORIGIN), ORIGIN, ROOM), Route::Refuse("This room was closed by its host.".into()));
        // The same room id through another origin is not this room.
        assert!(matches!(classify(&paired(ORIGIN), &listed("joined", "https://other.example"), ORIGIN, ROOM), Route::Refuse(_)));
        // Not paired: no person, or a person without a pairing record.
        assert_eq!(classify(&json!({ "initialized": false, "pairedWith": null }), &none, ORIGIN, ROOM), Route::NotPaired);
        assert_eq!(classify(&json!({ "initialized": true, "pairedWith": null }), &none, ORIGIN, ROOM), Route::NotPaired);
        assert_eq!(classify(&json!({}), &json!({}), ORIGIN, ROOM), Route::NotPaired);
        // One person per app: another room service is refused, naming whom the app is paired with.
        assert_eq!(classify(&paired("https://other.example"), &none, ORIGIN, ROOM), Route::OtherService { name: "Robin Lee".into(), origin: "https://other.example".into() });
        // Loopback spellings are different origins, as the bridge compares them.
        assert!(matches!(classify(&paired("http://127.0.0.1:4317"), &none, "http://localhost:4317", ROOM), Route::OtherService { .. }));
        // Paired, at that service, and not in the room (or declined, expired or removed there): ask.
        assert_eq!(classify(&paired(ORIGIN), &none, ORIGIN, ROOM), Route::Ask { name: "Robin Lee".into() });
        for state in ["declined", "expired", "removed"] {
            assert_eq!(classify(&paired(ORIGIN), &listed(state, ORIGIN), ORIGIN, ROOM), Route::Ask { name: "Robin Lee".into() }, "{state}");
        }
    }

    fn asking(joining: &mut Joining, now: Instant) -> u64 {
        let id = joining.offer(ORIGIN.into(), ROOM.into(), now).unwrap();
        assert_eq!(joining.checked(id, Route::Ask { name: "Robin".into() }, now), Some(Route::Ask { name: "Robin".into() }));
        id
    }

    #[test]
    fn join_runs_only_after_the_title_is_shown_and_never_names_a_secret() {
        let (mut joining, now) = (Joining::default(), Instant::now());
        let id = asking(&mut joining, now);
        let view = joining.view(now);
        assert_eq!((view["stage"].as_str(), view["titled"].as_bool()), (Some("confirm"), Some(false)));
        // Join waits for the title.
        assert_eq!(joining.confirm(id, now).err(), Some(Refused::Nothing));
        joining.titles(id, &json!({ "rooms": [{ "roomId": ROOM, "title": "Launch\u{202E} <b>plan</b>" }] }));
        let view = joining.view(now);
        assert_eq!(view["title"], "Launch <b>plan</b>", "plain, cleaned text: the page renders it as text");
        assert_eq!((view["origin"].as_str(), view["name"].as_str(), view["known"].as_bool()), (Some(ORIGIN), Some("Robin"), Some(true)));
        let handover = joining.confirm(id, now).unwrap();
        assert_eq!(handover.id, id);
        assert_eq!(handover.args, vec!["person".to_string(), "join".into(), format!("{ORIGIN}/r/{ROOM}")]);
        // Once: a second press does nothing.
        assert_eq!(joining.confirm(id, now).err(), Some(Refused::Nothing));
        assert_eq!(joining.view(now)["stage"], "sending");
    }

    #[test]
    fn an_unreadable_title_is_shown_as_unavailable() {
        let (mut joining, now) = (Joining::default(), Instant::now());
        let id = asking(&mut joining, now);
        joining.titles(id, &json!({}));
        let view = joining.view(now);
        assert_eq!((view["title"].as_str(), view["known"].as_bool(), view["titled"].as_bool()), (Some("Room 00000000"), Some(false), Some(true)));
        assert!(joining.confirm(id, now).is_ok());
    }

    #[test]
    fn one_join_at_a_time_until_it_ends_or_expires() {
        let (mut joining, now) = (Joining::default(), Instant::now());
        let id = joining.offer(ORIGIN.into(), ROOM.into(), now).unwrap();
        // While the status is read, and while the window asks, another link is refused.
        assert_eq!(joining.offer(ORIGIN.into(), ROOM.into(), now).err(), Some(Refused::Busy));
        joining.checked(id, Route::Ask { name: "Robin".into() }, now);
        assert_eq!(joining.offer(ORIGIN.into(), ROOM.into(), now).err(), Some(Refused::Busy));
        joining.titles(id, &json!({}));
        let handover = joining.confirm(id, now).unwrap();
        assert_eq!(joining.offer(ORIGIN.into(), ROOM.into(), now).err(), Some(Refused::Busy));
        // Asked: still busy while the host decides.
        assert!(!joining.sent(handover.id, Ok(json!({ "roomId": ROOM, "state": "waiting" }))));
        assert!(joining.waiting(id));
        assert_eq!(joining.offer(ORIGIN.into(), ROOM.into(), now).err(), Some(Refused::Busy));
        // Rooms that aren't this one change nothing; the host letting it in ends it, and the room opens.
        assert!(!joining.progress(id, &json!([{ "roomId": "00000000-0000-4000-8000-000000000002", "state": "joined" }])));
        assert!(!joining.progress(id, &json!([{ "roomId": ROOM, "state": "waiting" }])));
        assert!(joining.progress(id, &json!([{ "roomId": ROOM, "state": "joined" }])));
        assert!(joining.begin_open(now));
        assert_eq!(joining.view(now)["stage"], "done");
        assert!(!joining.progress(id, &json!([{ "roomId": ROOM, "state": "joined" }])), "opened once");
        // Opened: the next link waits out the cooldown, and is then taken.
        joining.opened();
        assert_eq!(joining.offer(ORIGIN.into(), ROOM.into(), now).err(), Some(Refused::Busy));
        let now = now + OPEN_COOLDOWN;
        let next = joining.offer(ORIGIN.into(), ROOM.into(), now).unwrap();
        assert_ne!(next, id);
        // A window left unanswered expires, and then gives way.
        joining.checked(next, Route::Ask { name: "Robin".into() }, now);
        joining.titles(next, &json!({}));
        let later = now + PENDING_FOR;
        assert_eq!(joining.view(later)["stage"], "expired");
        assert_eq!(joining.confirm(next, later).err(), Some(Refused::Expired));
        assert!(joining.offer(ORIGIN.into(), ROOM.into(), later).is_ok());
    }

    #[test]
    fn refusals_and_endings_free_the_next_link_and_say_why() {
        let now = Instant::now();
        for route in [Route::NotPaired, Route::OtherService { name: "Alex".into(), origin: "https://other.example".into() }, Route::Refuse("closed".into())] {
            let mut joining = Joining::default();
            let id = joining.offer(ORIGIN.into(), ROOM.into(), now).unwrap();
            joining.checked(id, route, now);
            assert!(joining.offer(ORIGIN.into(), ROOM.into(), now).is_ok());
        }
        // A room that opened is the exception: the next link waits out the cooldown.
        let mut joining = Joining::default();
        let id = joining.offer(ORIGIN.into(), ROOM.into(), now).unwrap();
        joining.checked(id, Route::Open, now);
        assert!(joining.begin_open(now));
        joining.opened();
        assert_eq!(joining.offer(ORIGIN.into(), ROOM.into(), now + OPEN_COOLDOWN / 2).err(), Some(Refused::Busy));
        assert!(joining.offer(ORIGIN.into(), ROOM.into(), now + OPEN_COOLDOWN).is_ok());
        let mut joining = Joining::default();
        let id = joining.offer(ORIGIN.into(), ROOM.into(), now).unwrap();
        joining.checked(id, Route::OtherService { name: "Alex".into(), origin: "https://other.example".into() }, now);
        let view = joining.view(now);
        assert_eq!((view["stage"].as_str(), view["pairedName"].as_str(), view["pairedOrigin"].as_str()), (Some("other-service"), Some("Alex"), Some("https://other.example")));
        // Refused here, the browser is still offered: the link's own room page.
        assert_eq!(joining.browser_page(), Some(format!("{ORIGIN}/r/{ROOM}")));
        // A refused join (the bridge's own check) says why, and ends.
        let mut joining = Joining::default();
        let id = asking(&mut joining, now);
        joining.titles(id, &json!({}));
        let handover = joining.confirm(id, now).unwrap();
        assert_eq!(joining.browser_page(), None, "not while asking");
        joining.sent(handover.id, Err("This app is paired with Robin at https://rooms.example, so it can't join a room at https://x.example: one person per app.".into()));
        assert!(joining.view(now)["problem"].as_str().unwrap().contains("one person per app"));
        assert!(!joining.waiting(id));
        // Declined, expired, or never decided in time.
        for (state, says) in [("declined", "declined"), ("expired", "expired"), ("removed", "removed")] {
            let mut joining = Joining::default();
            let id = asking(&mut joining, now);
            joining.titles(id, &json!({}));
            joining.confirm(id, now).unwrap();
            joining.sent(id, Ok(json!({ "state": "waiting" })));
            assert!(!joining.progress(id, &json!([{ "roomId": ROOM, "state": state }])));
            assert!(joining.view(now)["problem"].as_str().unwrap().contains(says), "{state}");
        }
        let mut joining = Joining::default();
        let id = asking(&mut joining, now);
        joining.titles(id, &json!({}));
        joining.confirm(id, now).unwrap();
        joining.sent(id, Ok(json!({ "state": "waiting" })));
        joining.timed_out(id);
        assert!(!joining.waiting(id));
        assert!(joining.view(now)["problem"].as_str().unwrap().contains("hasn't let you in"));
        // Joined at once (the room admits this device straight away): the room opens.
        let mut joining = Joining::default();
        let id = asking(&mut joining, now);
        joining.titles(id, &json!({}));
        joining.confirm(id, now).unwrap();
        assert!(joining.sent(id, Ok(json!({ "state": "joined" }))));
        assert!(!joining.waiting(id));
    }

    #[test]
    fn cancel_ends_the_join_at_any_stage() {
        let (mut joining, now) = (Joining::default(), Instant::now());
        let id = asking(&mut joining, now);
        joining.cancel();
        assert_eq!(joining.view(now)["stage"], "none");
        assert_eq!(joining.confirm(id, now).err(), Some(Refused::Nothing));
        // Asked and waiting for the host: closing the window stops following it, and the next link is taken at once.
        let id = asking(&mut joining, now);
        joining.titles(id, &json!({}));
        joining.confirm(id, now).unwrap();
        joining.sent(id, Ok(json!({ "state": "waiting" })));
        assert!(joining.waiting(id));
        joining.cancel();
        assert!(!joining.waiting(id));
        assert!(!joining.progress(id, &json!([{ "roomId": ROOM, "state": "joined" }])), "a cancelled join never opens the room");
        assert!(joining.offer(ORIGIN.into(), ROOM.into(), now).is_ok());
    }

    #[test]
    fn join_names_the_join_the_window_showed() {
        let (mut joining, now) = (Joining::default(), Instant::now());
        let first = asking(&mut joining, now);
        joining.cancel();
        let second = asking(&mut joining, now);
        joining.titles(second, &json!({}));
        // A Join pressed in a window that showed the first link does nothing to the second.
        assert_eq!(joining.confirm(first, now).err(), Some(Refused::Nothing));
        assert_eq!(joining.view(now)["id"], second);
        assert_eq!(joining.view(now)["stage"], "confirm");
        assert_eq!(joining.confirm(second, now).unwrap().id, second);
    }

    #[test]
    fn a_flood_of_links_opens_one_room_per_cooldown_and_never_queues_opens() {
        let (mut joining, start) = (Joining::default(), Instant::now());
        let (mut accepted, mut opens) = (0, 0);
        // A page firing a link every 10 ms for a minute, for a room the app is in.
        for tick in 0..6000u32 {
            let now = start + Duration::from_millis(10) * tick;
            let Ok(id) = joining.offer(ORIGIN.into(), ROOM.into(), now) else { continue };
            accepted += 1;
            if joining.checked(id, Route::Open, now) == Some(Route::Open) && joining.begin_open(now) {
                opens += 1;
            }
            // The open takes a while: it ends 3 s later (here, at the next accepted link at the latest).
            if tick % 300 == 299 {
                joining.opened();
            }
        }
        assert!(accepted <= 6 + 1 && opens == accepted, "{accepted} links taken, {opens} opens, in 60 s");
        // While an open is under way, another is dropped, not queued; and that room stays busy past the cooldown.
        let mut joining = Joining::default();
        let id = joining.offer(ORIGIN.into(), ROOM.into(), start).unwrap();
        joining.checked(id, Route::Open, start);
        assert!(joining.begin_open(start));
        assert!(!joining.begin_open(start), "a second open while one is under way is dropped");
        assert_eq!(joining.offer(ORIGIN.into(), ROOM.into(), start + OPEN_COOLDOWN * 3).err(), Some(Refused::Busy), "still opening");
        joining.opened();
        assert!(joining.offer(ORIGIN.into(), ROOM.into(), start + OPEN_COOLDOWN).is_ok());
    }

    #[test]
    fn only_the_join_window_may_use_its_commands() {
        assert!(ours_label(WINDOW).is_ok());
        for other in ["main", "pair", "link-approval", "Join", "join ", ""] {
            assert_eq!(ours_label(other), Err("Not available here.".to_string()), "{other}");
        }
    }
}
