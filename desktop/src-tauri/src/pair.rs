//! Pairing this computer with the person's browser (src/browser/pairing.ts; internal/docs/design/desktop-first.md,
//! "Identity and pairing"). A meshrooms://pair link (links.rs) opens a native window from the app's own bundle. It
//! words the link as what it is, a claim: "A browser calling itself <name>, at <origin>, asks to add <N> rooms". The
//! person types the phrase their browser shows; once it matches, the window lists the rooms' public titles, and only a
//! final Pair hands the browser's secret to the bridge, on stdin (`person pair`), which asks to join each room with a
//! proof bound to this machine's key and the browser's device; the person then confirms in that browser.
//!
//! The controls of machine-daemon.md, threat 1: the phrase is typed here, never filled in for the person; one pairing
//! waits at a time, and a second link is refused while it does; a pairing waits 15 minutes at most; five wrong phrases
//! end it; the app pairs with one person (the bridge refuses another browser until the app is unpaired, from this window).
//! The secret lives only in the pending pairing, and is zeroed as soon as it is handed over, rejected, or ends. It is
//! never logged, shown, or put on a command line; the phrase never goes to the window either.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The pairing window's label: commands answer only to it.
pub const WINDOW: &str = "pair";
pub const PENDING_FOR: Duration = Duration::from_secs(15 * 60);
pub const MAX_WRONG: u32 = 5;
/// How often the window's progress is read from `person rooms` while the person confirms in the browser.
const PROGRESS_EVERY: Duration = Duration::from_secs(2);

/// The word list both sides share (src/browser/pair-words.json): 256 words.
fn words() -> &'static [String] {
    static WORDS: OnceLock<Vec<String>> = OnceLock::new();
    WORDS.get_or_init(|| serde_json::from_str(include_str!("../../../src/browser/pair-words.json")).expect("pair-words.json is a list of words"))
}

/// Four words: word i is byte i of sha256("phrase:" ++ secret), as the browser shows them.
pub fn phrase(secret: &[u8; 32]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"phrase:");
    hasher.update(secret);
    let digest = hasher.finalize();
    digest[..4].iter().map(|&byte| words()[byte as usize].as_str()).collect::<Vec<_>>().join(" ")
}

/// A typed phrase as compared: lower case, words separated by single spaces (src/browser/pairing.ts normalPhrase).
pub fn normal(typed: &str) -> String {
    typed
        .to_lowercase()
        .split(|c: char| c.is_whitespace() || matches!(c, ',' | '.' | '-'))
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// base64url without padding, as the browser spelled the secret.
fn encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// HMAC-SHA256 (RFC 2104).
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let pad = |byte: u8| block.map(|b| b ^ byte);
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(message).finalize();
    Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize().into()
}

/// The running daemon's local control token (server/local-api.ts localControlToken), from the endpoint file only this
/// OS user can read: how `person pair` and `person unpair` know the app asks, not a bare command (agent-cli.ts appOnly).
fn control_token(endpoint: &str) -> Result<String, String> {
    let record: Value = serde_json::from_str(endpoint).map_err(|_| "Meshrooms' local endpoint file is unreadable.".to_string())?;
    let secret = record["secret"].as_str().filter(|secret| secret.len() >= 32).ok_or("Meshrooms' local endpoint file has no secret.")?;
    Ok(encode(&hmac_sha256(secret.as_bytes(), b"meshrooms-local-control")))
}

/// The first line of stdin for `person pair`, `person unpair` and `person join`: the app's proof.
pub(crate) fn app_proof() -> Result<String, String> {
    let file = crate::runtime::home()?.join(".meshrooms").join("daemon").join("local-api.json");
    let text = std::fs::read_to_string(&file).map_err(|_| "The Meshrooms daemon isn't running yet. Try again in a moment.".to_string())?;
    control_token(&text)
}

fn wipe(bytes: &mut [u8]) {
    for byte in bytes.iter_mut() {
        // Volatile, so the compiler can't drop a write it sees no later read of.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stage {
    /// Waiting for the typed phrase.
    Asking,
    /// The phrase matched: the window lists the rooms, and waits for the final Pair.
    Reviewing,
    /// The bridge is asking to join the rooms.
    Sending,
    /// The requests are out: the person confirms in the browser.
    Waiting,
    Done,
    Failed(String),
}

/// One pairing. No Debug: it holds the secret until it is handed over.
pub struct Pending {
    pub id: u64,
    pub origin: String,
    pub name: String,
    pub device: String,
    pub rooms: Vec<String>,
    secret: [u8; 32],
    phrase: String,
    opened: Instant,
    wrong: u32,
    pub stage: Stage,
    /// Each room's title (once known) and state, by room id.
    progress: Vec<(String, Option<String>, String)>,
    /// Whether the titles were read (or could not be): the final Pair shows only then.
    titled: bool,
}

impl Drop for Pending {
    fn drop(&mut self) {
        wipe(&mut self.secret);
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// Another pairing, or an unpairing, is waiting or under way.
    Busy,
    Expired,
    Wrong { left: u32 },
    /// Too many wrong phrases: this pairing is over.
    Ended,
    /// Nothing is waiting for this step.
    Nothing,
}

/// What a confirmed pairing hands the bridge: the command, and its stdin (the secret, wiped by the caller once sent).
pub struct Handover {
    pub id: u64,
    pub args: Vec<String>,
    pub input: Vec<u8>,
    /// When the pairing ends however far it got: 15 minutes after the link arrived, never 15 after the final Pair.
    pub until: Instant,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UnpairStage {
    Confirm,
    Working,
    /// Unpaired, every room left.
    Done,
    /// Unpaired, but these rooms kept this device and lost their host (the person chose to go on anyway).
    Kept(Vec<String>),
    /// Not unpaired, and nothing deleted: why, and the rooms that stopped it. The person may try again.
    Failed(String, Vec<String>),
}

/// What the window asks before unpairing (`person unpair --check`).
pub struct UnpairPlan {
    pub name: String,
    pub origin: String,
    pub rooms: usize,
    /// Rooms this device is the only host device of: they would keep this device and lose their host.
    pub sole_host: Vec<String>,
    /// Rooms the room service didn't answer for: unpairing would stop there.
    pub unreachable: usize,
}

/// Unpairing, asked for from the tray: whom the app is paired with, and how far it got.
pub struct Unpair {
    pub plan: UnpairPlan,
    pub stage: UnpairStage,
}

/// Room names from the bridge's answer (`title`, else the start of the room id), as plain short text.
fn room_names(rows: &Value) -> Vec<String> {
    rows.as_array()
        .map(|rows| {
            rows.iter()
                .map(|row| match row["title"].as_str().map(|title| crate::text::clean(title, 60)).filter(|title| !title.is_empty()) {
                    Some(title) => title,
                    None => format!("Room {}", row["roomId"].as_str().and_then(|id| id.get(..8)).unwrap_or("?")),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The app's one pairing at a time, or its unpairing. Pure: the window and the bridge are wired in below.
#[derive(Default)]
pub struct Pairing {
    pending: Option<Pending>,
    unpair: Option<Unpair>,
    next: u64,
}

impl Pairing {
    fn live(&self, now: Instant) -> bool {
        if self.unpair.as_ref().is_some_and(|u| u.stage == UnpairStage::Working) {
            return true;
        }
        match &self.pending {
            Some(p) => match p.stage {
                Stage::Asking | Stage::Reviewing => now.duration_since(p.opened) < PENDING_FOR,
                // Under way, but never past the pairing's 15 minutes (the progress reader ends it then).
                Stage::Sending | Stage::Waiting => now.duration_since(p.opened) < PENDING_FOR,
                Stage::Done | Stage::Failed(_) => false,
            },
            None => false,
        }
    }

    /// A pairing link arrived. Refused while another one waits or runs; one that ended (or expired) is replaced.
    pub fn offer(&mut self, origin: String, name: String, device: String, rooms: Vec<String>, mut secret: [u8; 32], now: Instant) -> Result<u64, Refused> {
        if self.live(now) {
            wipe(&mut secret);
            return Err(Refused::Busy);
        }
        self.unpair = None;
        self.next += 1;
        let phrase = phrase(&secret);
        let progress = rooms.iter().map(|room| (room.clone(), None, "waiting".to_string())).collect();
        self.pending = Some(Pending { id: self.next, origin, name, device, rooms, secret, phrase, opened: now, wrong: 0, stage: Stage::Asking, progress, titled: false });
        wipe(&mut secret);
        Ok(self.next)
    }

    /// The pairing at `stage`, unexpired.
    fn at(&mut self, stage: Stage, now: Instant) -> Result<&mut Pending, Refused> {
        let expired = match &self.pending {
            Some(p) if p.stage == stage => now.duration_since(p.opened) >= PENDING_FOR,
            _ => return Err(Refused::Nothing),
        };
        if expired {
            self.pending = None;
            return Err(Refused::Expired);
        }
        Ok(self.pending.as_mut().expect("checked above"))
    }

    /// Whether `typed` is the phrase, for the window's Next button. Not a try: only pressing Next counts.
    pub fn matches(&mut self, typed: &str, now: Instant) -> bool {
        self.at(Stage::Asking, now).is_ok_and(|p| normal(typed) == p.phrase)
    }

    /// The person pressed Next with a phrase. A wrong one counts; the fifth ends the pairing. The right one moves on to
    /// the rooms' titles (the caller fetches them: the pairing's id, origin and rooms) and the final Pair.
    pub fn verify(&mut self, typed: &str, now: Instant) -> Result<(u64, String, Vec<String>), Refused> {
        let pending = self.at(Stage::Asking, now)?;
        if normal(typed) != pending.phrase {
            pending.wrong += 1;
            if pending.wrong >= MAX_WRONG {
                self.pending = None;
                return Err(Refused::Ended);
            }
            return Err(Refused::Wrong { left: MAX_WRONG - pending.wrong });
        }
        pending.phrase.clear();
        pending.stage = Stage::Reviewing;
        Ok((pending.id, pending.origin.clone(), pending.rooms.clone()))
    }

    /// The rooms' public titles (`person titles`), shown before the final Pair.
    pub fn titles(&mut self, id: u64, rows: &Value) {
        if let Some(pending) = self.current(id) {
            pending.absorb(rows["rooms"].as_array().map(Vec::as_slice).unwrap_or_default(), false);
            pending.titled = true;
        }
    }

    /// The final Pair: hands over the bridge command and the secret for its stdin; the pairing keeps neither after.
    pub fn confirm(&mut self, now: Instant) -> Result<Handover, Refused> {
        let pending = self.at(Stage::Reviewing, now)?;
        // Never before the rooms were listed for the person to see.
        if !pending.titled {
            return Err(Refused::Nothing);
        }
        let mut input = encode(&pending.secret).into_bytes();
        input.push(b'\n');
        wipe(&mut pending.secret);
        pending.stage = Stage::Sending;
        let args = vec![
            "person".into(), "pair".into(),
            "--origin".into(), pending.origin.clone(),
            "--rooms".into(), pending.rooms.join(","),
            "--name".into(), pending.name.clone(),
            "--device".into(), pending.device.clone(),
        ];
        Ok(Handover { id: pending.id, args, input, until: pending.opened + PENDING_FOR })
    }

    pub fn reject(&mut self) {
        self.pending = None;
        if self.unpair.as_ref().is_some_and(|u| u.stage != UnpairStage::Working) {
            self.unpair = None;
        }
    }

    fn current(&mut self, id: u64) -> Option<&mut Pending> {
        self.pending.as_mut().filter(|p| p.id == id)
    }

    /// The bridge's answer to `person pair`.
    pub fn sent(&mut self, id: u64, result: Result<Value, String>) {
        let Some(pending) = self.current(id) else { return };
        match result {
            Ok(answer) => {
                pending.stage = Stage::Waiting;
                pending.absorb(answer["rooms"].as_array().map(Vec::as_slice).unwrap_or_default(), true);
            }
            Err(error) => pending.stage = Stage::Failed(crate::text::clean(&error, 160)),
        }
    }

    /// `person rooms`, read while the person confirms in the browser. Done once every room is joined or failed.
    pub fn progress(&mut self, id: u64, rooms: &Value) {
        let Some(pending) = self.current(id) else { return };
        if pending.stage != Stage::Waiting {
            return;
        }
        pending.absorb(rooms.as_array().map(Vec::as_slice).unwrap_or_default(), true);
        if pending.progress.iter().all(|(_, _, state)| state != "waiting") {
            pending.stage = if pending.progress.iter().any(|(_, _, state)| state == "joined") { Stage::Done } else { Stage::Failed("No room could be paired.".into()) };
        }
    }

    /// The person didn't confirm in time: the pairing ends (paired, for the rooms that joined), so a later link isn't
    /// refused as busy. Rooms still waiting keep their requests until those expire.
    pub fn timed_out(&mut self, id: u64) {
        let Some(pending) = self.current(id) else { return };
        if matches!(pending.stage, Stage::Sending | Stage::Waiting) {
            pending.stage = if pending.progress.iter().any(|(_, _, state)| state == "joined") {
                Stage::Done
            } else {
                Stage::Failed("Your browser didn't confirm the pairing in time. Start again from your browser.".into())
            };
        }
    }

    /// Whether `id` is still the pairing under way (the progress reader stops when it isn't).
    pub fn waiting(&self, id: u64) -> bool {
        self.pending.as_ref().is_some_and(|p| p.id == id && matches!(p.stage, Stage::Sending | Stage::Waiting))
    }

    /// Unpairing was asked for from the tray. Refused while a pairing waits or runs.
    pub fn ask_unpair(&mut self, plan: UnpairPlan, now: Instant) -> Result<(), Refused> {
        if self.live(now) {
            return Err(Refused::Busy);
        }
        self.pending = None;
        self.unpair = Some(Unpair { plan, stage: UnpairStage::Confirm });
        Ok(())
    }

    /// The person pressed Unpair (or Try again): the caller runs `person unpair`, with `--anyway` when the window named
    /// rooms that would lose their host (the returned flag).
    pub fn start_unpair(&mut self) -> Result<bool, Refused> {
        match &mut self.unpair {
            Some(unpair) if matches!(unpair.stage, UnpairStage::Confirm | UnpairStage::Failed(..)) => {
                unpair.stage = UnpairStage::Working;
                Ok(!unpair.plan.sole_host.is_empty())
            }
            _ => Err(Refused::Nothing),
        }
    }

    /// `person unpair`'s answer: done only when every room was left; rooms kept or failed are named, never hidden.
    pub fn unpaired(&mut self, result: Result<Value, String>) {
        if let Some(unpair) = &mut self.unpair {
            unpair.stage = match result {
                Ok(answer) if answer["unpaired"] == Value::Bool(true) => {
                    let kept = room_names(&answer["kept"]);
                    if kept.is_empty() { UnpairStage::Done } else { UnpairStage::Kept(kept) }
                }
                Ok(answer) => UnpairStage::Failed(
                    answer["next"].as_str().map(|next| crate::text::clean(next, 160)).unwrap_or_else(|| "Nothing was deleted. Try again.".into()),
                    room_names(&answer["failed"]),
                ),
                Err(error) => UnpairStage::Failed(crate::text::clean(&error, 160), Vec::new()),
            };
        }
    }

    /// What the window shows: never the secret, never the phrase.
    pub fn view(&self, now: Instant) -> Value {
        if let Some(u) = &self.unpair {
            let none = Vec::new();
            let (stage, problem, listed) = match &u.stage {
                UnpairStage::Confirm => ("unpair", None, &u.plan.sole_host),
                UnpairStage::Working => ("unpairing", None, &none),
                UnpairStage::Done => ("unpaired", None, &none),
                UnpairStage::Kept(kept) => ("unpaired-kept", None, kept),
                UnpairStage::Failed(problem, rooms) => ("unpair-failed", Some(problem.clone()), rooms),
            };
            let p = &u.plan;
            return json!({ "stage": stage, "name": p.name, "origin": p.origin, "roomCount": p.rooms, "soleHost": p.sole_host, "unreachable": p.unreachable,
                "listed": listed, "problem": problem });
        }
        let Some(p) = &self.pending else { return json!({ "stage": "none" }) };
        let expired = now.duration_since(p.opened) >= PENDING_FOR;
        let (stage, problem) = match &p.stage {
            Stage::Asking | Stage::Reviewing if expired => ("expired", None),
            Stage::Asking => ("asking", None),
            Stage::Reviewing => ("reviewing", None),
            Stage::Sending => ("sending", None),
            Stage::Waiting => ("waiting", None),
            Stage::Done => ("done", None),
            Stage::Failed(problem) => ("failed", Some(problem.clone())),
        };
        let rooms: Vec<Value> = if p.stage == Stage::Asking {
            Vec::new()
        } else {
            p.progress.iter().map(|(room, title, state)| json!({ "title": title.clone().unwrap_or_else(|| format!("Room {}", &room[..8])), "known": title.is_some(), "state": state })).collect()
        };
        json!({ "stage": stage, "name": p.name, "origin": p.origin, "roomCount": p.rooms.len(), "wrong": p.wrong, "left": MAX_WRONG - p.wrong, "rooms": rooms, "titled": p.titled, "problem": problem })
    }
}

impl Pending {
    /// Titles and (with `states`) room states from the bridge, for this pairing's rooms only.
    fn absorb(&mut self, rows: &[Value], states: bool) {
        for row in rows {
            let Some(id) = row["roomId"].as_str() else { continue };
            let Some(entry) = self.progress.iter_mut().find(|(room, _, _)| room == id) else { continue };
            if let Some(title) = row["title"].as_str().map(|title| crate::text::clean(title, 60)).filter(|title| !title.is_empty()) {
                entry.1 = Some(title);
            }
            if !states {
                continue;
            }
            entry.2 = match row["state"].as_str() {
                Some("joined") => "joined",
                Some("failed" | "declined" | "expired" | "closed" | "removed") => "failed",
                _ => "waiting",
            }
            .to_string();
        }
    }
}

/// Only the pairing window may use these commands; any other window (the status page, a notice) is refused.
pub fn ours_label(label: &str) -> Result<(), String> {
    if label == WINDOW { Ok(()) } else { Err("Not available here.".into()) }
}

// The window and the bridge.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

fn state(app: &AppHandle) -> std::sync::MutexGuard<'_, Pairing> {
    crate::lock(app.state::<Mutex<Pairing>>().inner())
}

#[cfg(debug_assertions)]
fn trace(what: &str) {
    eprintln!("pairing: {what}");
}
#[cfg(not(debug_assertions))]
fn trace(_: &str) {}

/// A pairing link arrived (links.rs): its window opens, or, while another pairing waits, a notice says so.
pub fn open(app: &AppHandle, origin: String, name: String, device: String, rooms: Vec<String>, secret: [u8; 32]) {
    let offered = state(app).offer(origin, name, device, rooms, secret, Instant::now());
    match offered {
        Ok(_) => {
            trace("asking");
            show(app);
        }
        Err(_) => {
            trace("refused a second pairing while one is pending");
            crate::links::notice_limited(app, "Another pairing is already waiting. Finish or reject it in its window first; this link was ignored.");
            if let Some(window) = app.get_webview_window(WINDOW) {
                let _ = window.set_focus();
            }
        }
    }
}

fn show(app: &AppHandle) {
    let window = match app.get_webview_window(WINDOW) {
        Some(window) => window,
        None => match WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("pair.html".into()))
            .title("Meshrooms: pair this computer")
            .inner_size(520.0, 600.0)
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

/// The window closed: whatever waited in it (a pairing before its requests went out, an unpairing not started) is
/// dropped. Requests already sent stay with the daemon.
pub fn closed(app: &AppHandle) {
    let mut pairing = state(app);
    if pairing.pending.as_ref().is_some_and(|p| matches!(p.stage, Stage::Asking | Stage::Reviewing)) {
        trace("rejected (window closed)");
    }
    let keep = pairing.pending.as_ref().is_some_and(|p| matches!(p.stage, Stage::Sending | Stage::Waiting));
    if !keep {
        pairing.reject();
    }
}

fn refusal(refused: Refused) -> String {
    match refused {
        Refused::Wrong { left } => format!("That isn't the phrase your browser shows. {left} tries left."),
        Refused::Ended => "Too many wrong phrases. This pairing was cancelled; start again from your browser.".into(),
        Refused::Expired => "This pairing expired. Start again from your browser.".into(),
        Refused::Busy => "A pairing is under way. Wait for it to finish.".into(),
        Refused::Nothing => "Nothing is waiting for this.".into(),
    }
}

/// Next: the typed phrase, checked here. On a match, the rooms' public titles are fetched for the final Pair.
pub fn verify_typed(app: &AppHandle, typed: &str) -> Result<(), String> {
    let verified = state(app).verify(typed, Instant::now());
    let (id, origin, rooms) = verified.map_err(|refused| {
        trace(&format!("{refused:?}"));
        refusal(refused)
    })?;
    trace("phrase matched; reading the rooms' titles");
    let app = app.clone();
    std::thread::spawn(move || {
        let list = rooms.join(",");
        // Titles that can't be read show as unavailable: the room ids still name what will be joined.
        let rows = crate::cli(&app, &["person", "titles", "--origin", &origin, "--rooms", &list]).unwrap_or_else(|_| json!({}));
        state(&app).titles(id, &rows);
        trace("titles listed");
    });
    Ok(())
}

/// The final Pair: the bridge asks in every room, then the window follows progress until the browser confirms.
pub fn confirm(app: &AppHandle) -> Result<(), String> {
    let Handover { id, args, mut input, until } = state(app).confirm(Instant::now()).map_err(refusal)?;
    trace("asking in the rooms");
    let app = app.clone();
    std::thread::spawn(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        // stdin: the app's proof, then the browser's secret.
        let result = app_proof().and_then(|proof| {
            let mut stdin = format!("{proof}\n").into_bytes();
            stdin.extend_from_slice(&input);
            let result = crate::bridge(&app).and_then(|bridge| crate::bridge::cli_with_input(&bridge, &refs, Some(&stdin)));
            wipe(&mut stdin);
            result
        });
        wipe(&mut input);
        trace(if result.is_ok() { "requests sent" } else { "requests failed" });
        state(&app).sent(id, result);
        while Instant::now() < until && state(&app).waiting(id) {
            std::thread::sleep(PROGRESS_EVERY);
            if let Ok(rooms) = crate::cli(&app, &["person", "rooms"]) {
                state(&app).progress(id, &rooms);
            }
        }
        state(&app).timed_out(id);
        trace("progress ended");
    });
    Ok(())
}

/// The tray's "Unpair this computer…": the window asks whether to forget the paired person.
pub fn ask_unpair(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // Reads only: whom the app is paired with, and the rooms that would lose their host, before anything changes.
        let check = crate::cli(&app, &["person", "unpair", "--check"]);
        let plan = match &check {
            Ok(check) if check["pairedWith"]["name"].is_string() || check["rooms"].as_u64().unwrap_or_default() > 0 => UnpairPlan {
                name: check["pairedWith"]["name"].as_str().map(|name| crate::text::clean(name, 64)).unwrap_or_else(|| "this computer's person".into()),
                origin: check["pairedWith"]["origin"].as_str().map(|origin| crate::text::clean(origin, 120)).unwrap_or_default(),
                rooms: check["rooms"].as_u64().unwrap_or_default() as usize,
                sole_host: room_names(&check["soleHost"]),
                unreachable: check["unreachable"].as_array().map(Vec::len).unwrap_or_default(),
            },
            Ok(_) => return crate::links::notice(&app, "This computer isn't paired with a browser."),
            Err(error) => return crate::links::notice(&app, &format!("Meshrooms could not read this computer's person: {}", crate::text::clean(error, 100))),
        };
        // An `if` condition drops its guard before the window opens (a guard held through it would block the window's
        // first view request).
        if state(&app).ask_unpair(plan, Instant::now()).is_ok() {
            trace("asking to unpair");
        }
        show(&app);
    });
}

/// Unpair (or Try again), pressed in the window: `person unpair`, which leaves the rooms and only then deletes this
/// machine's person; `--anyway` only when the window named rooms that would lose their host.
pub fn unpair(app: &AppHandle) -> Result<(), String> {
    let anyway = state(app).start_unpair().map_err(refusal)?;
    trace("unpairing");
    let app = app.clone();
    std::thread::spawn(move || {
        let args: &[&str] = if anyway { &["person", "unpair", "--anyway"] } else { &["person", "unpair"] };
        let result = app_proof().and_then(|proof| crate::bridge(&app).and_then(|bridge| crate::bridge::cli_with_input(&bridge, args, Some(format!("{proof}\n").as_bytes()))));
        trace(match &result {
            Ok(answer) if answer["unpaired"] == Value::Bool(true) => "unpaired",
            Ok(_) => "unpair stopped: nothing deleted",
            Err(_) => "unpair failed",
        });
        state(&app).unpaired(result);
    });
    Ok(())
}

fn ours(window: &WebviewWindow) -> Result<(), String> {
    ours_label(window.label())
}

#[tauri::command]
pub fn pair_view(window: WebviewWindow) -> Result<Value, String> {
    ours(&window)?;
    #[cfg(debug_assertions)]
    {
        static SEEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if !SEEN.swap(true, std::sync::atomic::Ordering::Relaxed) {
            trace("the window reads its view");
        }
    }
    Ok(state(window.app_handle()).view(Instant::now()))
}

#[tauri::command]
pub fn pair_check(window: WebviewWindow, typed: String) -> Result<bool, String> {
    ours(&window)?;
    Ok(state(window.app_handle()).matches(&typed, Instant::now()))
}

#[tauri::command]
pub fn pair_verify(window: WebviewWindow, typed: String) -> Result<(), String> {
    ours(&window)?;
    verify_typed(window.app_handle(), &typed)
}

#[tauri::command]
pub fn pair_confirm(window: WebviewWindow) -> Result<(), String> {
    ours(&window)?;
    confirm(window.app_handle())
}

#[tauri::command]
pub fn pair_reject(window: WebviewWindow) -> Result<(), String> {
    ours(&window)?;
    closed(window.app_handle());
    trace("rejected");
    let _ = window.close();
    Ok(())
}

#[tauri::command]
pub fn pair_unpair(window: WebviewWindow) -> Result<(), String> {
    ours(&window)?;
    unpair(window.app_handle())
}

/// Close: the window goes; what is under way (requests sent, an unpairing) carries on, and anything still waiting for the
/// person is dropped (closed()). The page has no core permissions, so it can't close itself.
#[tauri::command]
pub fn pair_close(window: WebviewWindow) -> Result<(), String> {
    ours(&window)?;
    let _ = window.close();
    Ok(())
}

#[tauri::command]
pub fn pair_open(window: WebviewWindow) -> Result<(), String> {
    ours(&window)?;
    crate::open_meshrooms(window.app_handle());
    let _ = window.close();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM: &str = "00000000-0000-4000-8000-000000000001";
    const ROOM2: &str = "00000000-0000-4000-8000-000000000002";
    fn count() -> [u8; 32] {
        std::array::from_fn(|i| i as u8)
    }
    fn offer(pairing: &mut Pairing, secret: [u8; 32], now: Instant) -> Result<u64, Refused> {
        pairing.offer("https://rooms.example".into(), "Robin".into(), "b".repeat(64), vec![ROOM.into(), ROOM2.into()], secret, now)
    }

    #[test]
    fn the_phrase_is_the_browsers() {
        // The same vectors as src/browser/pairing.test.ts.
        assert_eq!(phrase(&[0; 32]), "coach clock cider lake");
        assert_eq!(phrase(&count()), "smoke raven whale hotel");
        assert_eq!(words().len(), 256);
        assert_eq!(normal("  Coach  CLOCK\tcider-lake "), "coach clock cider lake");
        assert_eq!(encode(&[0; 32]), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        assert_eq!(encode(&count()), "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    }

    #[test]
    fn only_the_typed_phrase_then_the_final_pair_hand_the_secret_to_stdin() {
        let (mut pairing, now) = (Pairing::default(), Instant::now());
        let id = offer(&mut pairing, count(), now).unwrap();
        assert!(!pairing.matches("smoke raven whale", now));
        assert!(pairing.matches("Smoke Raven Whale Hotel", now));
        // The window learns the claim (who and where), never the phrase or the secret, and no rooms yet.
        let shown = pairing.view(now).to_string();
        assert!(shown.contains("Robin") && shown.contains("https://rooms.example") && shown.contains("\"roomCount\":2") && shown.contains("\"rooms\":[]"));
        assert!(!shown.contains("smoke") && !shown.contains("AAECAw"));
        // Nothing is handed over before the phrase matched.
        assert_eq!(pairing.confirm(now).err(), Some(Refused::Nothing));
        assert_eq!(pairing.verify("smoke raven whale lake", now).err(), Some(Refused::Wrong { left: MAX_WRONG - 1 }));
        let (verified, origin, rooms) = pairing.verify("smoke raven whale hotel", now).unwrap();
        assert_eq!((verified, origin.as_str(), rooms.len()), (id, "https://rooms.example", 2));
        assert_eq!(pairing.view(now)["titled"], false, "the final Pair waits for the titles");
        assert_eq!(pairing.confirm(now).err(), Some(Refused::Nothing));
        // Reviewing: the rooms' public titles, as plain capped text, before the final Pair.
        pairing.titles(id, &json!({ "rooms": [{ "roomId": ROOM, "title": "Launch\u{202E} plan" }, { "roomId": ROOM2, "title": null }] }));
        let view = pairing.view(now);
        assert_eq!(view["stage"], "reviewing");
        assert_eq!(view["titled"], true);
        assert_eq!(view["rooms"], json!([{ "title": "Launch plan", "known": true, "state": "waiting" }, { "title": "Room 00000000", "known": false, "state": "waiting" }]));
        let handover = pairing.confirm(now).unwrap();
        assert_eq!(handover.id, id);
        assert_eq!(handover.input, b"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\n");
        let args = handover.args.join(" ");
        assert_eq!(args, format!("person pair --origin https://rooms.example --rooms {ROOM},{ROOM2} --name Robin --device {}", "b".repeat(64)));
        assert!(!args.contains("AAECAw"), "the secret is never on the command line");
        // Handed over: nothing of it is kept, and neither step can run again.
        let pending = pairing.pending.as_ref().unwrap();
        assert_eq!(pending.secret, [0; 32]);
        assert!(pending.phrase.is_empty());
        assert_eq!(pending.stage, Stage::Sending);
        assert_eq!(pairing.verify("smoke raven whale hotel", now).err(), Some(Refused::Nothing));
        assert_eq!(pairing.confirm(now).err(), Some(Refused::Nothing));
    }

    #[test]
    fn five_wrong_phrases_end_the_pairing() {
        let (mut pairing, now) = (Pairing::default(), Instant::now());
        offer(&mut pairing, count(), now).unwrap();
        for left in (1..MAX_WRONG).rev() {
            assert_eq!(pairing.verify("acorn acorn acorn acorn", now).err(), Some(Refused::Wrong { left }));
        }
        assert_eq!(pairing.verify("acorn acorn acorn acorn", now).err(), Some(Refused::Ended));
        assert!(pairing.pending.is_none());
        assert_eq!(pairing.verify("smoke raven whale hotel", now).err(), Some(Refused::Nothing));
    }

    #[test]
    fn one_pairing_at_a_time_until_it_ends_or_expires() {
        let (mut pairing, now) = (Pairing::default(), Instant::now());
        offer(&mut pairing, count(), now).unwrap();
        assert_eq!(offer(&mut pairing, [7; 32], now).err(), Some(Refused::Busy));
        // The first one is untouched by the refused one.
        assert!(pairing.matches("smoke raven whale hotel", now));
        let (verified, _, _) = pairing.verify("smoke raven whale hotel", now).unwrap();
        pairing.titles(verified, &json!({}));
        assert_eq!(offer(&mut pairing, [7; 32], now).err(), Some(Refused::Busy));
        // Under way, still busy; finished, replaced.
        let handover = pairing.confirm(now).unwrap();
        assert_eq!(offer(&mut pairing, [7; 32], now).err(), Some(Refused::Busy));
        pairing.sent(handover.id, Ok(json!({ "rooms": [{ "roomId": ROOM, "state": "waiting", "title": "Launch" }, { "roomId": ROOM2, "state": "failed" }] })));
        assert_eq!(pairing.pending.as_ref().unwrap().stage, Stage::Waiting);
        assert_eq!(offer(&mut pairing, [7; 32], now).err(), Some(Refused::Busy));
        pairing.progress(handover.id, &json!([{ "roomId": ROOM, "state": "joined", "title": "Launch" }, { "roomId": "other", "state": "joined" }]));
        assert_eq!(pairing.pending.as_ref().unwrap().stage, Stage::Done);
        let view = pairing.view(now);
        assert_eq!(view["stage"], "done");
        assert_eq!(view["rooms"], json!([{ "title": "Launch", "known": true, "state": "joined" }, { "title": "Room 00000000", "known": false, "state": "failed" }]));
        assert!(offer(&mut pairing, [7; 32], now).is_ok());
        // An expired one is gone: the phrase no longer pairs, and a new link takes its place.
        let later = now + PENDING_FOR;
        assert_eq!(pairing.view(later)["stage"], "expired");
        assert_eq!(pairing.verify(&phrase(&[7; 32]), later).err(), Some(Refused::Expired));
        assert!(offer(&mut pairing, count(), later).is_ok());
        // Rejected: nothing waits any more.
        pairing.reject();
        assert_eq!(pairing.view(later)["stage"], "none");
    }

    #[test]
    fn a_pairing_the_browser_never_confirms_ends_so_the_next_link_is_not_refused() {
        let (mut pairing, now) = (Pairing::default(), Instant::now());
        offer(&mut pairing, count(), now).unwrap();
        let (verified, _, _) = pairing.verify("smoke raven whale hotel", now).unwrap();
        pairing.titles(verified, &json!({}));
        let handover = pairing.confirm(now).unwrap();
        pairing.sent(handover.id, Ok(json!({ "rooms": [{ "roomId": ROOM, "state": "waiting" }, { "roomId": ROOM2, "state": "waiting" }] })));
        assert!(pairing.waiting(handover.id));
        assert_eq!(offer(&mut pairing, [7; 32], now).err(), Some(Refused::Busy));
        pairing.timed_out(handover.id);
        assert!(!pairing.waiting(handover.id));
        assert_eq!(pairing.view(now)["problem"], "Your browser didn't confirm the pairing in time. Start again from your browser.");
        assert!(offer(&mut pairing, [7; 32], now).is_ok());
    }

    #[test]
    fn a_failed_handover_says_why_and_ends() {
        let (mut pairing, now) = (Pairing::default(), Instant::now());
        offer(&mut pairing, count(), now).unwrap();
        let (verified, _, _) = pairing.verify("smoke raven whale hotel", now).unwrap();
        pairing.titles(verified, &json!({}));
        let handover = pairing.confirm(now).unwrap();
        pairing.sent(handover.id, Err("This app is paired with Alex at https://rooms.example. Unpair it first in the app.".into()));
        assert_eq!(pairing.view(now)["problem"], "This app is paired with Alex at https://rooms.example. Unpair it first in the app.");
        assert!(!pairing.waiting(handover.id));
        assert!(offer(&mut pairing, count(), now).is_ok());
    }

    fn plan(sole_host: &[&str]) -> UnpairPlan {
        UnpairPlan { name: "Robin".into(), origin: "https://rooms.example".into(), rooms: 2, sole_host: sole_host.iter().map(|s| s.to_string()).collect(), unreachable: 0 }
    }

    #[test]
    fn unpairing_is_asked_then_confirmed_and_never_overlaps_a_pairing() {
        let (mut pairing, now) = (Pairing::default(), Instant::now());
        offer(&mut pairing, count(), now).unwrap();
        assert_eq!(pairing.ask_unpair(plan(&[]), now).err(), Some(Refused::Busy));
        pairing.reject();
        pairing.ask_unpair(plan(&[]), now).unwrap();
        assert_eq!(pairing.view(now)["stage"], "unpair");
        assert_eq!(pairing.view(now)["name"], "Robin");
        assert_eq!(pairing.start_unpair(), Ok(false), "no room loses its host: no --anyway");
        assert_eq!(pairing.start_unpair().err(), Some(Refused::Nothing));
        // While it runs, a pairing link waits its turn; closing the window doesn't drop it.
        assert_eq!(offer(&mut pairing, count(), now).err(), Some(Refused::Busy));
        pairing.reject();
        assert_eq!(pairing.view(now)["stage"], "unpairing");
        pairing.unpaired(Ok(json!({ "unpaired": true, "kept": [], "failed": [] })));
        assert_eq!(pairing.view(now)["stage"], "unpaired");
        assert!(offer(&mut pairing, count(), now).is_ok());
        assert_eq!(pairing.view(now)["stage"], "asking");
    }

    #[test]
    fn unpairing_names_rooms_that_lose_their_host_and_never_reports_done_for_kept_or_failed_rooms() {
        let now = Instant::now();
        // The window names them before anything changes, and going on is --anyway.
        let mut pairing = Pairing::default();
        pairing.ask_unpair(plan(&["Mine"]), now).unwrap();
        assert_eq!(pairing.view(now)["listed"], json!(["Mine"]));
        assert_eq!(pairing.start_unpair(), Ok(true));
        // Unpaired, but a room kept this device: not "unpaired", and the room is named.
        pairing.unpaired(Ok(json!({ "unpaired": true, "kept": [{ "roomId": ROOM, "title": "Mine" }], "failed": [] })));
        let view = pairing.view(now);
        assert_eq!(view["stage"], "unpaired-kept");
        assert_eq!(view["listed"], json!(["Mine"]));
        // A room that couldn't be left (the network): nothing deleted, named, and Try again runs it once more.
        let mut pairing = Pairing::default();
        pairing.ask_unpair(plan(&[]), now).unwrap();
        pairing.start_unpair().unwrap();
        pairing.unpaired(Ok(json!({ "unpaired": false, "next": "Nothing was deleted. Try again when these rooms can be reached.",
            "failed": [{ "roomId": ROOM, "title": null, "error": "The room service did not answer." }] })));
        let view = pairing.view(now);
        assert_eq!(view["stage"], "unpair-failed");
        assert_eq!(view["problem"], "Nothing was deleted. Try again when these rooms can be reached.");
        assert_eq!(view["listed"], json!(["Room 00000000"]));
        assert_eq!(pairing.start_unpair(), Ok(false));
        assert_eq!(pairing.view(now)["stage"], "unpairing");
        // A bridge that failed outright is a failure too, never done.
        pairing.unpaired(Err("Pair and unpair from the Meshrooms app: its window asks you first.".into()));
        assert_eq!(pairing.view(now)["stage"], "unpair-failed");
    }

    #[test]
    fn a_pairing_never_runs_past_fifteen_minutes_from_its_link() {
        let (mut pairing, now) = (Pairing::default(), Instant::now());
        offer(&mut pairing, count(), now).unwrap();
        let later = now + PENDING_FOR - Duration::from_secs(60);
        let (id, _, _) = pairing.verify("smoke raven whale hotel", later).unwrap();
        pairing.titles(id, &json!({}));
        let handover = pairing.confirm(later).unwrap();
        assert_eq!(handover.until, now + PENDING_FOR, "the progress reader stops 15 minutes after the link, not after Pair");
        pairing.sent(id, Ok(json!({ "rooms": [{ "roomId": ROOM, "state": "waiting" }] })));
        assert_eq!(offer(&mut pairing, [7; 32], later).err(), Some(Refused::Busy));
        assert!(offer(&mut pairing, [7; 32], now + PENDING_FOR).is_ok(), "past its 15 minutes, a pairing under way no longer holds the app");
    }

    #[test]
    fn the_control_token_is_the_daemons() {
        // server/local-api.ts localControlToken('x' * 43), and RFC 4231 test case 2.
        let endpoint = json!({ "port": 1, "pid": 1, "secret": "x".repeat(43) }).to_string();
        assert_eq!(control_token(&endpoint).unwrap(), "nW50JyN1J3pNVBut82QvSklNJGch0x5-KaY0T3XLjLY");
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(mac.iter().map(|b| format!("{b:02x}")).collect::<String>(), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        assert!(control_token("{}").is_err());
        assert!(control_token(&json!({ "secret": "short" }).to_string()).is_err());
    }

    #[test]
    fn only_the_pairing_window_may_use_its_commands() {
        assert!(ours_label(WINDOW).is_ok());
        for other in ["main", "link-approval", "Pair", "pair ", ""] {
            assert_eq!(ours_label(other), Err("Not available here.".to_string()), "{other}");
        }
    }
}
