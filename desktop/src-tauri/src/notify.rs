//! Desktop notifications (internal/docs/design/desktop-first.md, "Presence and notifications"). The daemon keeps a short
//! feed of what the person should hear about (server/notifications.ts): mentions and replies, people waiting to be let
//! in, agents that need attention, approvals waiting. This thread reads it through the bridge (`person notifications`,
//! with the app's proof on stdin, as `person join` takes it), as a long poll (`LONG_POLL`), backing off after failures,
//! and posts each entry as a native notification, its title prefixed with "Meshrooms · " so that no room or agent name
//! can pass as a notice of the system's. Notifications are posted from Rust only: no window's capability grants any notification permission.
//!
//! When the app starts, and whenever the daemon comes back after it couldn't be reached (or restarted), one more
//! notification says which agents are live and listening, in how many rooms, and names any that did not come back
//! (`agent review`). It waits up to `SETTLE` for agents that are still starting, so a slow runner isn't called failed.
//!
//! Clicking a notification opens what it is about: the room in the localhost UI (`person open --room`, the tray's own
//! path), the Review window (review.rs) for agents, or the Approvals window (approvals.rs). On Windows a click reaches the
//! app only while it runs: the toast is shown with an activation callback (there is no COM activator, so a click on one
//! left in the notification center after the app quit does nothing). A development build run from `target\debug`
//! posts under PowerShell's AppUserModelID, as the notification plugin does; an installed build under the app's
//! identifier, which the installer's Start menu shortcut carries.

use serde_json::Value;
use std::time::{Duration, Instant};

/// How often reviews are read while the agents summary waits for agents still starting.
pub const EVERY: Duration = Duration::from_secs(5);
/// Every notification from the feed is titled under this, so a room named like a system notice can't pass as one.
pub const TITLE_PREFIX: &str = "Meshrooms · ";
/// After the daemon comes back, how long the agents summary waits for agents that are still starting.
pub const SETTLE: Duration = Duration::from_secs(60);

/// What clicking a notification opens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// The room, in the localhost UI.
    Room(String),
    /// The Review window: the bound agents.
    Review,
    /// The Approvals window: what waits for the person's approval (the feed's `app` target).
    Approvals,
}

/// One notification to post: inert text and where it leads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub title: String,
    pub body: String,
    pub target: Target,
}

/// A room id as room links carry it: lowercase hex in the UUID shape. Anything else is no room to open.
fn room_id(text: &str) -> bool {
    text.len() == 36
        && text.char_indices().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_digit() || ('a'..='f').contains(&c) })
}

/// One entry of the daemon's feed, as a notice: its text cleaned again (one short inert line each), and its target
/// checked. An entry that doesn't parse is skipped.
pub fn notice_of(entry: &Value) -> Option<Notice> {
    let title = crate::text::clean(entry["title"].as_str()?, 80);
    // The title is room or agent text: under a fixed prefix, never on its own.
    let title = if title.is_empty() { title } else { format!("{TITLE_PREFIX}{title}") };
    let body = crate::text::clean(entry["body"].as_str().unwrap_or_default(), 200);
    let target = match entry["target"]["kind"].as_str()? {
        "room" => Target::Room(entry["target"]["roomId"].as_str().filter(|room| room_id(room))?.to_string()),
        "review" => Target::Review,
        "app" => Target::Approvals,
        _ => return None,
    };
    (!title.is_empty()).then_some(Notice { title, body, target })
}

fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The "agents live" notice from `agent review`: how many are live and listening, in how many rooms, and every agent that
/// isn't, by name and room (failed, paused, waiting or still starting). None when no agent is bound.
pub fn summary(review: &Value) -> Option<Notice> {
    let agents = review["agents"].as_array().filter(|agents| !agents.is_empty())?;
    let live = review["summary"]["live"].as_u64().unwrap_or(0);
    let rooms = review["summary"]["rooms"].as_u64().unwrap_or(0);
    let title = if live == 0 { "No agents are live".to_string() } else { format!("{} live in {}", plural(live, "agent", "agents"), plural(rooms, "room", "rooms")) };
    let named = |state: &str| -> Vec<String> {
        agents
            .iter()
            .filter(|row| row["state"].as_str() == Some(state))
            .map(|row| {
                let name = crate::text::clean(row["name"].as_str().unwrap_or("An agent"), 30);
                match row["title"].as_str().map(|title| crate::text::clean(title, 30)).filter(|title| !title.is_empty()) {
                    Some(room) => format!("{name} in {room}"),
                    None => name,
                }
            })
            .collect()
    };
    let mut parts = Vec::new();
    for (state, words) in [("failed", "Did not come back"), ("paused", "Paused"), ("waiting", "Waiting for the host"), ("starting", "Still starting")] {
        let names = named(state);
        if !names.is_empty() {
            parts.push(format!("{words}: {}.", names.join(", ")));
        }
    }
    let body = if parts.is_empty() { "All listening. Click to review them.".to_string() } else { format!("{} Click to review.", parts.join(" ")) };
    Some(Notice { title: crate::text::clean(&title, 80), body: crate::text::clean(&body, 240), target: Target::Review })
}

/// Whether a review still has agents starting (the summary waits for them, up to `SETTLE`).
pub fn settling(review: &Value) -> bool {
    review["agents"].as_array().is_some_and(|agents| agents.iter().any(|row| row["state"].as_str() == Some("starting")))
}

/// How long one read of the feed waits for an entry (a long poll): the bridge runs about this often while all is quiet.
pub const LONG_POLL: Duration = Duration::from_secs(20);
/// After a failed read (or review), the next waits this long, doubling up to `MAX_BACKOFF`.
pub const FIRST_BACKOFF: Duration = Duration::from_secs(5);
pub const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// A due summary whose review can't be read for this long past `SETTLE` is given up: the next reconnect makes it due again.
pub const GIVE_UP: Duration = Duration::from_secs(5 * 60);

/// An exponential backoff: `FIRST_BACKOFF`, doubling with each failure up to `MAX_BACKOFF`, back to none on success.
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Backoff(Option<Duration>);

impl Backoff {
    pub fn failed(&mut self) -> Duration {
        let next = self.0.map_or(FIRST_BACKOFF, |last| (last * 2).min(MAX_BACKOFF));
        self.0 = Some(next);
        next
    }
    pub fn succeeded(&mut self) {
        self.0 = None;
    }
}

/// The feed reader's state between reads: the cursor while the daemon answers, and when a summary is due.
#[derive(Default)]
pub struct Reader {
    cursor: Option<String>,
    /// The daemon came back (or the app started): post the agents summary once nothing is starting, or by this time.
    summary_by: Option<Instant>,
    /// Reads of the feed that failed in a row, and reviews read while the summary is due.
    feed: Backoff,
    review: Backoff,
    /// When the next review may be read (after a failed one).
    review_at: Option<Instant>,
}

impl Reader {
    /// One read of the feed: `Ok` with its answer, or `Err` when the daemon couldn't be reached. Returns what to post.
    /// The app's first answer, and an answer that says `reset` (another daemon: the one that was unreachable came back
    /// as a new one), start from the end of the feed and make the summary due.
    pub fn read(&mut self, answer: Result<Value, String>, now: Instant) -> Vec<Notice> {
        // A failed read keeps the cursor: a daemon that comes back is a new one (it restarted), whose answer to the old
        // cursor says `reset`; the same daemon after a passing hiccup (a slow bridge) goes on where it was.
        let Ok(answer) = answer else {
            self.feed.failed();
            return Vec::new();
        };
        let Some(cursor) = answer["cursor"].as_str().map(str::to_string) else {
            self.feed.failed();
            return Vec::new();
        };
        self.feed.succeeded();
        let fresh = self.cursor.is_none() || answer["reset"] == Value::Bool(true);
        self.cursor = Some(cursor);
        if fresh {
            self.summary_by = Some(now + SETTLE);
            self.review = Backoff::default();
            self.review_at = None;
            return Vec::new();
        }
        answer["notifications"].as_array().map(|list| list.iter().filter_map(notice_of).collect()).unwrap_or_default()
    }

    /// The arguments of the next read: a long poll once there is a cursor, unless the summary is due (its reviews are
    /// read every `EVERY` meanwhile).
    pub fn args(&self) -> Vec<String> {
        let mut args = vec!["person".to_string(), "notifications".to_string()];
        if let Some(cursor) = &self.cursor {
            let wait = if self.summary_due() { 0 } else { LONG_POLL.as_secs() };
            args.extend(["--after".to_string(), cursor.clone(), "--wait".to_string(), wait.to_string()]);
        }
        args
    }

    /// How long to wait before the next read: the backoff after failures, `EVERY` while the summary is due, else none
    /// (the read itself waits).
    pub fn pause(&self) -> Duration {
        match self.feed.0 {
            Some(backoff) => backoff,
            None if self.summary_due() => EVERY,
            None => Duration::from_millis(500),
        }
    }

    pub fn summary_due(&self) -> bool {
        self.summary_by.is_some()
    }

    /// Whether a review should be read now, while the summary is due (not before the backoff of a failed one).
    pub fn review_now(&self, now: Instant) -> bool {
        self.summary_due() && self.review_at.is_none_or(|at| now >= at)
    }

    /// A review read while the summary is due: the notice to post once nothing is starting (or the wait is over), and
    /// none while it waits. A review that couldn't be read is tried again after a backoff, and given up `GIVE_UP` after
    /// the summary was due.
    pub fn reviewed(&mut self, review: Result<Value, String>, now: Instant) -> Option<Notice> {
        let by = self.summary_by?;
        let review = match review {
            Ok(review) => review,
            Err(_) => {
                self.review_at = Some(now + self.review.failed());
                if now >= by + GIVE_UP {
                    self.summary_by = None;
                }
                return None;
            }
        };
        self.review.succeeded();
        self.review_at = None;
        if settling(&review) && now < by {
            return None;
        }
        self.summary_by = None;
        summary(&review)
    }
}

// Posting, and the thread.

use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// What this app posted, newest last (a few), so development builds can click one without a mouse.
#[derive(Default)]
pub struct Posted(pub Vec<Notice>);
const POSTED_KEPT: usize = 20;

#[cfg(debug_assertions)]
fn trace(what: &str) {
    eprintln!("notify: {what}");
}
#[cfg(not(debug_assertions))]
fn trace(_: &str) {}

/// Opens what a notification is about. Runs off the thread that delivered the click.
pub fn click(app: &AppHandle, target: &Target) {
    trace(&format!("clicked {target:?}"));
    match target {
        Target::Room(room) => crate::open_meshrooms_at(app, Some(room.clone())),
        Target::Review => crate::review::show(app),
        Target::Approvals => crate::approvals::show(app),
    }
}

/// Posts `notice`. Development builds with `MESHROOMS_DEV_NOTIFIED=<file>` append it to that file as a JSON line instead,
/// so checks can follow it without a notification on the desktop. Never in a release.
fn post(app: &AppHandle, notice: Notice) {
    {
        let posted = app.state::<Mutex<Posted>>();
        let mut posted = crate::lock(posted.inner());
        posted.0.push(notice.clone());
        let extra = posted.0.len().saturating_sub(POSTED_KEPT);
        posted.0.drain(..extra);
    }
    #[cfg(debug_assertions)]
    if let Some(file) = std::env::var_os("MESHROOMS_DEV_NOTIFIED") {
        use std::io::Write;
        let target = match &notice.target {
            Target::Room(room) => serde_json::json!({ "kind": "room", "roomId": room }),
            Target::Review => serde_json::json!({ "kind": "review" }),
            Target::Approvals => serde_json::json!({ "kind": "app" }),
        };
        let line = serde_json::json!({ "title": notice.title, "body": notice.body, "target": target });
        if let Ok(mut out) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
            let _ = writeln!(out, "{line}");
        }
        return;
    }
    if !permitted(app) {
        trace("notifications are not permitted");
        return;
    }
    show(app, notice);
}

/// Asks for permission the first time anything is posted, and remembers the answer.
fn permitted(app: &AppHandle) -> bool {
    use tauri::plugin::PermissionState;
    use tauri_plugin_notification::NotificationExt;
    static ASKED: Mutex<Option<bool>> = Mutex::new(None);
    let mut asked = crate::lock(&ASKED);
    if let Some(answer) = *asked {
        return answer;
    }
    let notification = app.notification();
    let state = match notification.permission_state() {
        Ok(PermissionState::Granted) => PermissionState::Granted,
        _ => notification.request_permission().unwrap_or(PermissionState::Denied),
    };
    let granted = state == PermissionState::Granted;
    *asked = Some(granted);
    granted
}

/// Windows: a toast with a click callback (the notification plugin has none on desktop).
#[cfg(windows)]
fn show(app: &AppHandle, notice: Notice) {
    use tauri_winrt_notification::Toast;
    // As the notification plugin decides: a development build in target\debug has no registered AppUserModelID, so its
    // toasts go out under PowerShell's; an installed build under the app's identifier.
    let dev = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.to_path_buf())).is_some_and(|dir| {
        let dir = dir.to_string_lossy().to_ascii_lowercase();
        dir.ends_with("\\target\\debug") || dir.ends_with("\\target\\release")
    });
    let id = if dev { Toast::POWERSHELL_APP_ID.to_string() } else { app.config().identifier.clone() };
    let (handle, target) = (app.clone(), notice.target.clone());
    // On a thread of its own, never the app's main (UI) thread, whose COM apartment the toast APIs refuse
    // (E_UNEXPECTED), as the notification plugin also shows them off it.
    std::thread::spawn(move || {
        let shown = Toast::new(&id)
            .title(&notice.title)
            .text1(&notice.body)
            .on_activated(move |_| {
                let (app, target) = (handle.clone(), target.clone());
                std::thread::spawn(move || click(&app, &target));
                Ok(())
            })
            .show();
        match shown {
            Ok(()) => trace(&format!("toast shown under {}", if dev { "PowerShell's id" } else { "the app's id" })),
            Err(error) => trace(&format!("toast not shown: {error:?}")),
        }
    });
}

/// Elsewhere: the notification plugin (macOS needs the signed app; clicks there are the macOS lane's).
#[cfg(not(windows))]
fn show(app: &AppHandle, notice: Notice) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(error) = app.notification().builder().title(&notice.title).body(&notice.body).show() {
        trace(&format!("notification not shown: {error}"));
    }
}

/// Runs one bridge command for the app, with its proof on stdin.
fn app_cli(app: &AppHandle, args: &[String]) -> Result<Value, String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let proof = crate::pair::app_proof()?;
    crate::bridge::cli_with_input(&*crate::bridge(app)?, &refs, Some(format!("{proof}\n").as_bytes()))
}

/// The feed reader: every `EVERY`, posts what the daemon's feed has, and the agents summary when it is due.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut reader = Reader::default();
        loop {
            let answer = app_cli(&app, &reader.args());
            if let Err(error) = &answer {
                trace(&format!("the feed couldn't be read: {}", crate::text::clean(error, 120)));
            }
            let was_due = reader.summary_due();
            for notice in reader.read(answer, Instant::now()) {
                trace(&format!("posting {:?}", notice.title));
                post(&app, notice);
            }
            if !was_due && reader.summary_due() {
                trace("the daemon answers: the agents summary is due");
            }
            if reader.review_now(Instant::now()) {
                let review = app_cli(&app, &["agent".into(), "review".into()]);
                if let Ok(review) = &review {
                    crate::review::refreshed(&app, review.clone());
                }
                if let Some(notice) = reader.reviewed(review, Instant::now()) {
                    trace(&format!("posting the summary {:?}", notice.title));
                    post(&app, notice);
                }
            }
            std::thread::sleep(reader.pause());
        }
    });
}

/// Development builds: posts the last notification again as a real one, whatever MESHROOMS_DEV_NOTIFIED says, so a check
/// can see one toast on the desktop through the real path.
#[cfg(debug_assertions)]
pub fn dev_real(app: &AppHandle) -> Result<(), String> {
    let notice = crate::lock(app.state::<Mutex<Posted>>().inner()).0.last().cloned().ok_or("Nothing was posted yet.")?;
    if !permitted(app) {
        return Err("Notifications are not permitted.".into());
    }
    trace(&format!("posting for real {:?}", notice.title));
    show(app, notice);
    Ok(())
}

/// Development builds: clicks the posted notification `which` (`last`, or its index among the kept ones), through the
/// same code as a real click.
#[cfg(debug_assertions)]
pub fn dev_click(app: &AppHandle, which: &str) -> Result<(), String> {
    let target = {
        let posted = app.state::<Mutex<Posted>>();
        let posted = crate::lock(posted.inner());
        let notice = if which == "last" { posted.0.last() } else { which.parse::<usize>().ok().and_then(|i| posted.0.get(i)) };
        notice.map(|notice| notice.target.clone()).ok_or("No such notification was posted.")?
    };
    click(app, &target);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ROOM: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn feed_entries_become_clean_notices_with_checked_targets() {
        let entry = json!({ "seq": 1, "title": "Launch\u{202E} plan", "body": "Alex mentioned you:\n@Robin look", "count": 1, "target": { "kind": "room", "roomId": ROOM } });
        assert_eq!(notice_of(&entry), Some(Notice { title: "Meshrooms · Launch plan".into(), body: "Alex mentioned you: @Robin look".into(), target: Target::Room(ROOM.into()) }));
        // A room named like a system notice still reads as Meshrooms'.
        assert_eq!(notice_of(&json!({ "title": "Windows Security", "body": "x", "target": { "kind": "app" } })).unwrap().title, "Meshrooms · Windows Security");
        assert_eq!(notice_of(&json!({ "title": "Wren needs attention", "body": "x", "target": { "kind": "review" } })).unwrap().target, Target::Review);
        assert_eq!(notice_of(&json!({ "title": "Approval waiting", "body": "x", "target": { "kind": "app" } })).unwrap().target, Target::Approvals);
        // A room that isn't a room id, an unknown target, or no title: skipped.
        for bad in [
            json!({ "title": "x", "target": { "kind": "room", "roomId": "../../etc" } }),
            json!({ "title": "x", "target": { "kind": "room", "roomId": "00000000-0000-4000-8000-00000000000G" } }),
            json!({ "title": "x", "target": { "kind": "url", "url": "https://example.com" } }),
            json!({ "title": "", "target": { "kind": "review" } }),
            json!({ "target": { "kind": "review" } }),
        ] {
            assert_eq!(notice_of(&bad), None, "{bad}");
        }
        assert_eq!(notice_of(&json!({ "title": "x", "body": "y".repeat(1_000), "target": { "kind": "app" } })).unwrap().body.chars().count(), 200);
    }

    fn review(rows: Value, live: u64, rooms: u64) -> Value {
        json!({ "summary": { "live": live, "rooms": rooms }, "agents": rows })
    }

    #[test]
    fn the_summary_counts_live_agents_and_rooms_and_names_every_one_that_is_not() {
        let rows = json!([
            { "name": "Wren", "title": "Launch", "state": "live" }, { "name": "Oak", "title": "Launch", "state": "live" },
            { "name": "Fern", "title": "Ops", "state": "live" }, { "name": "Ash", "title": "Ops", "state": "live" },
        ]);
        assert_eq!(summary(&review(rows, 4, 2)), Some(Notice { title: "4 agents live in 2 rooms".into(), body: "All listening. Click to review them.".into(), target: Target::Review }));
        let rows = json!([
            { "name": "Wren", "title": "Launch", "state": "live" },
            { "name": "Oak\u{202E}", "title": "Ops", "state": "failed" }, { "name": "Fern", "title": null, "state": "paused" },
            { "name": "Ash", "title": "Ops", "state": "starting" },
        ]);
        let notice = summary(&review(rows, 1, 1)).unwrap();
        assert_eq!(notice.title, "1 agent live in 1 room");
        assert_eq!(notice.body, "Did not come back: Oak in Ops. Paused: Fern. Still starting: Ash in Ops. Click to review.");
        assert_eq!(summary(&review(json!([{ "name": "Oak", "title": "Ops", "state": "failed" }]), 0, 0)).unwrap().title, "No agents are live");
        // Nothing bound: no notice at all.
        assert_eq!(summary(&review(json!([]), 0, 0)), None);
        assert_eq!(summary(&json!({})), None);
    }

    #[test]
    fn the_reader_starts_at_the_end_posts_what_follows_and_makes_the_summary_due_on_start_and_reconnect() {
        let mut reader = Reader::default();
        let now = Instant::now();
        assert_eq!(reader.args(), vec!["person", "notifications"]);
        // The app starts: the first answer gives the cursor only, and the summary is due.
        assert!(reader.read(Ok(json!({ "cursor": "abcd0123.4", "notifications": [] })), now).is_empty());
        assert!(reader.summary_due());
        // While the summary is due, the feed is read without waiting (its reviews go every EVERY).
        assert_eq!(reader.args(), vec!["person", "notifications", "--after", "abcd0123.4", "--wait", "0"]);
        assert_eq!(reader.pause(), EVERY);
        // Agents still starting: the summary waits, up to SETTLE.
        let starting = review(json!([{ "name": "Wren", "title": "Launch", "state": "starting" }]), 0, 0);
        assert_eq!(reader.reviewed(Ok(starting.clone()), now + Duration::from_secs(5)), None);
        assert!(reader.summary_due());
        assert_eq!(reader.reviewed(Err("not running".into()), now + Duration::from_secs(10)), None);
        let live = review(json!([{ "name": "Wren", "title": "Launch", "state": "live" }]), 1, 1);
        assert_eq!(reader.reviewed(Ok(live.clone()), now + Duration::from_secs(15)).unwrap().title, "1 agent live in 1 room");
        assert!(!reader.summary_due());
        assert_eq!(reader.reviewed(Ok(live.clone()), now + Duration::from_secs(20)), None, "posted once");
        // Then a long poll, read again at once when it answers.
        assert_eq!(reader.args(), vec!["person", "notifications", "--after", "abcd0123.4", "--wait", "20"]);
        assert!(reader.pause() < Duration::from_secs(1));
        // Entries after the cursor are posted.
        let posted = reader.read(Ok(json!({ "cursor": "abcd0123.5", "notifications": [{ "title": "Launch", "body": "Alex: hi", "target": { "kind": "room", "roomId": ROOM } }] })), now);
        assert_eq!(posted.len(), 1);
        // A read that fails keeps the cursor; the same daemon answering again is no reconnect.
        assert!(reader.read(Err("the bridge was slow".into()), now).is_empty());
        assert_eq!(reader.args(), vec!["person", "notifications", "--after", "abcd0123.5", "--wait", "20"]);
        assert_eq!(reader.pause(), FIRST_BACKOFF);
        assert!(reader.read(Ok(json!({ "cursor": "abcd0123.5", "notifications": [] })), now).is_empty());
        assert!(!reader.summary_due());
        // The daemon can't be reached, then a new one answers the old cursor with `reset`: due again, nothing posted.
        assert!(reader.read(Err("not running".into()), now).is_empty());
        assert!(reader.read(Ok(json!({ "cursor": "ffff0000.0", "reset": true, "notifications": [] })), now).is_empty());
        assert!(reader.summary_due());
        // A summary that waited SETTLE goes out anyway, naming who is still starting.
        assert_eq!(reader.reviewed(Ok(starting.clone()), now + SETTLE).unwrap().body, "Still starting: Wren in Launch. Click to review.");
        // Another daemon behind the same address (reset): due again, nothing from the stale cursor.
        let reset = reader.read(Ok(json!({ "cursor": "11112222.0", "reset": true, "notifications": [{ "title": "x", "target": { "kind": "app" } }] })), now);
        assert!(reset.is_empty());
        assert!(reader.summary_due());
    }

    #[test]
    fn failures_back_off_exponentially_to_a_minute_and_a_due_summary_whose_review_fails_is_given_up() {
        let mut backoff = Backoff::default();
        let waits: Vec<u64> = (0..6).map(|_| backoff.failed().as_secs()).collect();
        assert_eq!(waits, vec![5, 10, 20, 40, 60, 60]);
        backoff.succeeded();
        assert_eq!(backoff.failed(), FIRST_BACKOFF);
        // The feed: each failed read waits longer.
        let mut reader = Reader::default();
        let now = Instant::now();
        for expected in [5, 10, 20, 40, 60, 60] {
            reader.read(Err("not running".into()), now);
            assert_eq!(reader.pause(), Duration::from_secs(expected));
        }
        // The summary: a review that fails is read again only after its backoff, and the summary is dropped GIVE_UP after due.
        assert!(reader.read(Ok(json!({ "cursor": "abcd0123.0", "notifications": [] })), now).is_empty());
        assert!(reader.review_now(now));
        assert_eq!(reader.reviewed(Err("slow".into()), now), None);
        assert!(!reader.review_now(now + Duration::from_secs(4)));
        assert!(reader.review_now(now + FIRST_BACKOFF));
        assert_eq!(reader.reviewed(Err("slow".into()), now + FIRST_BACKOFF), None);
        assert!(!reader.review_now(now + FIRST_BACKOFF + Duration::from_secs(9)));
        assert!(reader.summary_due());
        assert_eq!(reader.reviewed(Err("slow".into()), now + SETTLE + GIVE_UP), None);
        assert!(!reader.summary_due(), "given up, not due forever");
        assert!(!reader.review_now(now + SETTLE + GIVE_UP + MAX_BACKOFF));
    }
}
