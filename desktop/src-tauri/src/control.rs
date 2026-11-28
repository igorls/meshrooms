//! Letting a browser control this computer's agents (docs/flows/remote-control.md, "Enrolling a controller"). A
//! meshrooms://control link (links.rs) opens a native window from the app's own bundle. It words the link as what it is, a
//! claim: "A browser calling itself <name>, at <origin>, asks to control the agents on this computer". The person types the
//! five words their browser shows; once they match, the window asks which harnesses remote prompts may reach here and
//! whether this browser may send prompts, and only Enrol hands the link to the bridge (`person control-enrol`), with the
//! app's proof, the browser's secret and the typed words on stdin. The daemon checks the words again, adds the browser as
//! a controller, and answers it with this computer's keys.
//!
//! The controls are pairing's (pair.rs): the words are typed here, never filled in for the person, and they bind the
//! link's origin, name, device and key, so a link changed on its way shows other words than the browser does; one
//! enrolment waits at a time, and a second link is refused while it does; it waits 15 minutes at most; five wrong tries
//! end it. The secret lives only in the pending enrolment and is zeroed as soon as it is handed over, rejected, or ends.
//! It is never logged, shown, or put on a command line; the words never go to the window either.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The enrolment window's label: commands answer only to it.
pub const WINDOW: &str = "control";
pub const PENDING_FOR: Duration = Duration::from_secs(15 * 60);
pub const MAX_WRONG: u32 = 5;
/// The harnesses remote prompts can reach (server/remote-control.ts REMOTE_HARNESSES).
pub const HARNESSES: [&str; 4] = ["claude", "codex", "hermes", "agy"];

/// A meshrooms://control link as links.rs parsed it: the browser's device, its keys, and the secret for the words. No
/// Debug: it holds the secret, which it wipes when dropped.
pub struct Link {
    pub origin: String,
    /// As the link carries it: the words bind it exactly. Shown cleaned.
    pub name: String,
    pub device: String,
    pub sign: String,
    pub enc: String,
    pub enc_version: u32,
    pub enc_sig: String,
    pub secret: [u8; 32],
}

impl Drop for Link {
    fn drop(&mut self) {
        crate::pair::wipe(&mut self.secret);
    }
}

/// Canonical standard base64 (with padding, no stray bits), as the browser exports its keys. None for anything else.
pub fn base64_bytes(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }
    let pad = bytes.iter().rev().take_while(|&&b| b == b'=').count();
    if pad > 2 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let (mut bits, mut count) = (0u32, 0u32);
    for &c in &bytes[..bytes.len() - pad] {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32;
        bits = (bits << 6) | value;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    (bits == 0).then_some(out)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The five words (src/browser/control-client.ts controlWords): word i is byte i of sha256 of "meshrooms-control-v1:" ++
/// secret ++ origin ++ name ++ device, each as its UTF-8 length in 4 bytes big-endian and then its bytes, ++ the raw
/// signing key.
pub fn words(secret: &[u8; 32], origin: &str, name: &str, device: &str, sign_key: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"meshrooms-control-v1:");
    hasher.update(secret);
    for field in [origin, name, device] {
        hasher.update((field.len() as u32).to_be_bytes());
        hasher.update(field.as_bytes());
    }
    hasher.update(sign_key);
    let digest = hasher.finalize();
    digest[..5].iter().map(|&byte| crate::pair::words()[byte as usize].as_str()).collect::<Vec<_>>().join(" ")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stage {
    /// Waiting for the typed words.
    Asking,
    /// The words matched: the window shows the choices and waits for Enrol.
    Reviewing,
    /// The bridge is enrolling the browser.
    Sending,
    Done,
    Failed(String),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// Another enrolment is waiting or under way.
    Busy,
    Expired,
    Wrong { left: u32 },
    /// Too many wrong tries: this enrolment is over.
    Ended,
    /// Nothing is waiting for this step.
    Nothing,
    /// A harness the window doesn't offer.
    Harness,
}

/// What the machine's policy is now, as `person remote-policy` read it: for the window to show before Enrol.
pub struct Policy {
    pub enabled: bool,
    /// The harnesses remote prompts reach now: none while remote control is off, whatever the file lists, so the window
    /// never shows a harness ticked that an enrolment would turn on.
    pub allowed: Vec<String>,
    /// Each remote harness, its label and whether this computer has it.
    pub harnesses: Vec<(String, String, bool)>,
}

/// One enrolment. No Debug: its link holds the secret until it is handed over.
pub struct Pending {
    pub id: u64,
    link: Link,
    /// The link's name, cleaned, for the window.
    label: String,
    words: String,
    typed: String,
    opened: Instant,
    wrong: u32,
    pub stage: Stage,
    policy: Option<Policy>,
    /// Whether reading the policy finished (or failed): the choices show only then.
    read: bool,
}

/// What Enrol hands the bridge: the command, and its stdin after the app's proof (the secret and the typed words).
pub struct Handover {
    pub id: u64,
    pub args: Vec<String>,
    pub input: Vec<u8>,
}

/// The app's one enrolment at a time. Pure: the window and the bridge are wired in below.
#[derive(Default)]
pub struct Enrolment {
    pending: Option<Pending>,
    next: u64,
}

impl Enrolment {
    fn live(&self, now: Instant) -> bool {
        match &self.pending {
            Some(p) => match p.stage {
                Stage::Asking | Stage::Reviewing => now.duration_since(p.opened) < PENDING_FOR,
                Stage::Sending => true,
                Stage::Done | Stage::Failed(_) => false,
            },
            None => false,
        }
    }

    /// A link arrived. Refused while another enrolment waits or runs; one that ended (or expired) is replaced.
    pub fn offer(&mut self, link: Link, now: Instant) -> Result<u64, Refused> {
        if self.live(now) {
            return Err(Refused::Busy);
        }
        let key = base64_bytes(&link.sign).ok_or(Refused::Nothing)?;
        self.next += 1;
        let words = words(&link.secret, &link.origin, &link.name, &link.device, &key);
        let label = crate::text::clean(&link.name, crate::links::MAX_NAME);
        self.pending = Some(Pending { id: self.next, link, label, words, typed: String::new(), opened: now, wrong: 0, stage: Stage::Asking, policy: None, read: false });
        Ok(self.next)
    }

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

    /// Whether `typed` is the words, for the window's Next button. Not a try: only pressing Next counts.
    pub fn matches(&mut self, typed: &str, now: Instant) -> bool {
        self.at(Stage::Asking, now).is_ok_and(|p| crate::pair::normal(typed) == p.words)
    }

    /// Next with the typed words. A wrong one counts; the fifth ends the enrolment. The right one moves on to the choices.
    pub fn verify(&mut self, typed: &str, now: Instant) -> Result<u64, Refused> {
        let pending = self.at(Stage::Asking, now)?;
        let typed = crate::pair::normal(typed);
        if typed != pending.words {
            pending.wrong += 1;
            if pending.wrong >= MAX_WRONG {
                self.pending = None;
                return Err(Refused::Ended);
            }
            return Err(Refused::Wrong { left: MAX_WRONG - pending.wrong });
        }
        pending.typed = typed;
        pending.words.clear();
        pending.stage = Stage::Reviewing;
        Ok(pending.id)
    }

    /// The machine's policy, read for the choices (None: it couldn't be read, and Enrol then leaves it as it is).
    pub fn policy(&mut self, id: u64, policy: Option<Policy>) {
        if let Some(pending) = self.pending.as_mut().filter(|p| p.id == id) {
            pending.policy = policy;
            pending.read = true;
        }
    }

    /// Enrol: the bridge command and its stdin. `allow`: the harnesses remote prompts may reach, sent only when the
    /// window showed the policy it changes.
    pub fn confirm(&mut self, trusted: bool, allow: &[String], now: Instant) -> Result<Handover, Refused> {
        let pending = self.at(Stage::Reviewing, now)?;
        if !pending.read {
            return Err(Refused::Nothing);
        }
        if allow.iter().any(|h| !HARNESSES.contains(&h.as_str())) {
            return Err(Refused::Harness);
        }
        let link = &mut pending.link;
        let mut input = crate::pair::encode(&link.secret).into_bytes();
        input.push(b'\n');
        input.extend_from_slice(pending.typed.as_bytes());
        input.push(b'\n');
        crate::pair::wipe(&mut link.secret);
        pending.typed.clear();
        let mut args: Vec<String> = vec![
            "person".into(), "control-enrol".into(),
            "--origin".into(), link.origin.clone(),
            "--name".into(), link.name.clone(),
            "--device".into(), link.device.clone(),
            "--sign".into(), link.sign.clone(),
            "--enc".into(), link.enc.clone(),
            "--enc-version".into(), link.enc_version.to_string(),
            "--enc-sig".into(), link.enc_sig.clone(),
            "--trusted".into(), if trusted { "yes" } else { "no" }.into(),
        ];
        // Only a change the person made: the snapshot is up to 15 minutes old, and sending it as it was would overwrite
        // whatever they changed elsewhere meanwhile.
        if let Some(policy) = &pending.policy {
            let chosen: Vec<&str> = HARNESSES.iter().copied().filter(|h| allow.iter().any(|a| a == h)).collect();
            let shown: Vec<&str> = HARNESSES.iter().copied().filter(|h| policy.allowed.iter().any(|a| a == h)).collect();
            if chosen != shown {
                args.push("--allow".into());
                args.push(if chosen.is_empty() { "none".into() } else { chosen.join(",") });
            }
        }
        pending.stage = Stage::Sending;
        Ok(Handover { id: pending.id, args, input })
    }

    /// The bridge's answer: enrolled, or why not.
    pub fn sent(&mut self, id: u64, result: Result<Value, String>) {
        if let Some(pending) = self.pending.as_mut().filter(|p| p.id == id) {
            pending.stage = match result {
                Ok(_) => Stage::Done,
                Err(error) => Stage::Failed(crate::text::clean(&error, 200)),
            };
        }
    }

    pub fn reject(&mut self) {
        if self.pending.as_ref().is_some_and(|p| p.stage != Stage::Sending) {
            self.pending = None;
        }
    }

    /// What the window shows: never the words, the secret or the keys.
    pub fn view(&mut self, now: Instant) -> Value {
        let expired = match &self.pending {
            None => return json!({ "stage": "none" }),
            Some(p) => matches!(p.stage, Stage::Asking | Stage::Reviewing) && now.duration_since(p.opened) >= PENDING_FOR,
        };
        if expired {
            self.pending = None;
            return json!({ "stage": "expired" });
        }
        let pending = self.pending.as_ref().expect("checked above");
        let stage = match &pending.stage {
            Stage::Asking => "asking",
            Stage::Reviewing => "reviewing",
            Stage::Sending => "sending",
            Stage::Done => "done",
            Stage::Failed(_) => "failed",
        };
        let harnesses: Vec<Value> = pending.policy.as_ref().map(|p| p.harnesses.iter().map(|(harness, label, detected)| json!({
            "harness": harness, "label": label, "detected": detected, "allowed": p.allowed.contains(harness),
        })).collect()).unwrap_or_default();
        json!({
            "id": pending.id, "stage": stage, "name": pending.label, "origin": pending.link.origin, "read": pending.read,
            "policyKnown": pending.policy.is_some(), "enabled": pending.policy.as_ref().is_some_and(|p| p.enabled), "harnesses": harnesses,
            "problem": match &pending.stage { Stage::Failed(why) => why.as_str(), _ => "" },
        })
    }
}

/// The policy `person remote-policy` answered, as the window shows it.
fn read_policy(answer: &Value) -> Option<Policy> {
    let enabled = answer["policy"]["enabled"].as_bool()?;
    let listed: Vec<String> = answer["policy"]["harnesses"].as_array()?.iter().filter_map(|h| h.as_str()).filter(|h| HARNESSES.contains(h)).map(String::from).collect();
    let allowed = if enabled { listed } else { Vec::new() };
    let harnesses = answer["harnesses"].as_array()?.iter().filter_map(|row| {
        let harness = row["harness"].as_str().filter(|h| HARNESSES.contains(h))?;
        Some((harness.to_string(), crate::text::clean(row["label"].as_str().unwrap_or(harness), 40), row["detected"].as_bool().unwrap_or(false)))
    }).collect();
    Some(Policy { enabled, allowed, harnesses })
}

// The window and the bridge.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

fn state(app: &AppHandle) -> std::sync::MutexGuard<'_, Enrolment> {
    crate::lock(app.state::<Mutex<Enrolment>>().inner())
}

/// A control link arrived (links.rs): its window opens, or, while another enrolment waits, a notice says so.
pub fn open(app: &AppHandle, link: Link) {
    let offered = state(app).offer(link, Instant::now());
    match offered {
        Ok(id) => {
            // No window, no one to type the words or reject them: the enrolment goes rather than block others for 15 minutes.
            if !show(app) {
                state(app).reject();
                return;
            }
            // The choices show the machine's policy as it is: read meanwhile, before the words are typed.
            let app = app.clone();
            std::thread::spawn(move || {
                let policy = crate::cli(&app, &["person", "remote-policy"]).ok().as_ref().and_then(read_policy);
                state(&app).policy(id, policy);
            });
        }
        Err(_) => {
            crate::links::notice_limited(app, "Another browser is already waiting to be let in. Finish or reject it in its window first; this link was ignored.");
            if let Some(window) = app.get_webview_window(WINDOW) {
                let _ = window.set_focus();
            }
        }
    }
}

fn show(app: &AppHandle) -> bool {
    let window = match app.get_webview_window(WINDOW) {
        Some(window) => window,
        None => match WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("control.html".into()))
            .title("Meshrooms: control this computer")
            .inner_size(520.0, 640.0)
            .build()
        {
            Ok(window) => window,
            Err(_) => return false,
        },
    };
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let _ = window.show();
    let _ = window.set_focus();
    true
}

/// Ends an enrolment under way however its thread ends: one that stopped without an answer (a panic) must not leave
/// every later link refused as busy.
struct Finish {
    app: AppHandle,
    id: u64,
    done: bool,
}

impl Drop for Finish {
    fn drop(&mut self) {
        if !self.done {
            state(&self.app).sent(self.id, Err("Letting the browser in stopped unexpectedly. Start again from your browser.".into()));
        }
    }
}

/// The window closed: an enrolment still waiting for the person is dropped (and its secret with it).
pub fn closed(app: &AppHandle) {
    state(app).reject();
}

fn refusal(refused: Refused) -> String {
    match refused {
        Refused::Wrong { left } => format!("Those aren't the words your browser shows. {left} tries left."),
        Refused::Ended => "Too many wrong tries. This was cancelled; start again from your browser.".into(),
        Refused::Expired => "This expired. Start again from your browser.".into(),
        Refused::Busy => "Another browser is being let in. Wait for it to finish.".into(),
        Refused::Nothing => "Nothing is waiting for this.".into(),
        Refused::Harness => "That harness can't be prompted remotely.".into(),
    }
}

/// Next: the typed words, checked here.
pub fn verify_typed(app: &AppHandle, typed: &str) -> Result<(), String> {
    state(app).verify(typed, Instant::now()).map(|_| ()).map_err(refusal)
}

/// Enrol: the bridge adds the browser as a controller of this computer, with the person's choices.
pub fn confirm(app: &AppHandle, trusted: bool, allow: Vec<String>) -> Result<(), String> {
    let Handover { id, args, mut input } = state(app).confirm(trusted, &allow, Instant::now()).map_err(refusal)?;
    let app = app.clone();
    std::thread::spawn(move || {
        let mut finish = Finish { app: app.clone(), id, done: false };
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        // stdin: the app's proof, then the browser's secret and the typed words.
        let result = crate::pair::app_proof().and_then(|proof| {
            let mut stdin = format!("{proof}\n").into_bytes();
            stdin.extend_from_slice(&input);
            let result = crate::bridge(&app).and_then(|bridge| crate::bridge::cli_with_input(&bridge, &refs, Some(&stdin)));
            crate::pair::wipe(&mut stdin);
            result
        });
        crate::pair::wipe(&mut input);
        state(&app).sent(id, result);
        finish.done = true;
    });
    Ok(())
}

fn ours(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == WINDOW { Ok(()) } else { Err("Not available here.".into()) }
}

#[tauri::command]
pub fn control_view(window: WebviewWindow) -> Result<Value, String> {
    ours(&window)?;
    Ok(state(window.app_handle()).view(Instant::now()))
}

#[tauri::command]
pub fn control_check(window: WebviewWindow, typed: String) -> Result<bool, String> {
    ours(&window)?;
    Ok(state(window.app_handle()).matches(&typed, Instant::now()))
}

#[tauri::command]
pub fn control_verify(window: WebviewWindow, typed: String) -> Result<(), String> {
    ours(&window)?;
    verify_typed(window.app_handle(), &typed)
}

#[tauri::command]
pub fn control_confirm(window: WebviewWindow, trusted: bool, allow: Vec<String>) -> Result<(), String> {
    ours(&window)?;
    confirm(window.app_handle(), trusted, allow)
}

#[tauri::command]
pub fn control_reject(window: WebviewWindow) -> Result<(), String> {
    ours(&window)?;
    closed(window.app_handle());
    let _ = window.close();
    Ok(())
}

/// Close: the window goes. An enrolment under way finishes with the daemon; one still waiting for the person is dropped.
#[tauri::command]
pub fn control_close(window: WebviewWindow) -> Result<(), String> {
    ours(&window)?;
    let _ = window.close();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The key the browser exports (65 bytes: 0x04 then 0..63), base64, as in the TypeScript vectors.
    const SIGN: &str = "BAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";
    fn count() -> [u8; 32] {
        std::array::from_fn(|i| i as u8)
    }
    fn link(secret: [u8; 32]) -> Link {
        Link {
            origin: "https://rooms.example".into(), name: "Robin".into(), device: "b".repeat(64), sign: SIGN.into(),
            enc: SIGN.into(), enc_version: 1, enc_sig: "A".repeat(86) + "==", secret,
        }
    }
    fn policy() -> Option<Policy> {
        Some(Policy { enabled: false, allowed: vec![], harnesses: vec![("claude".into(), "Claude Code".into(), true), ("codex".into(), "Codex".into(), false)] })
    }
    fn on(allowed: &[&str]) -> Option<Policy> {
        Some(Policy { enabled: true, allowed: allowed.iter().map(|h| h.to_string()).collect(), harnesses: vec![("claude".into(), "Claude Code".into(), true), ("codex".into(), "Codex".into(), true)] })
    }

    #[test]
    fn the_words_are_the_browsers() {
        // The same vectors as the TypeScript controlWords (computed from src/browser/control-client.ts).
        let key = base64_bytes(SIGN).unwrap();
        assert_eq!(key.len(), 65);
        assert_eq!(words(&count(), "https://rooms.example", "Robin", &"b".repeat(64), &key), "basil tower reef smoke scarf");
        assert_eq!(words(&[0; 32], "https://rooms.example", "Zoë Laptop", &"a".repeat(64), &key), "hero circle slope cinema satin");
        // Every field counts.
        assert_ne!(words(&count(), "https://rooms.example", "Robin ", &"b".repeat(64), &key), "basil tower reef smoke scarf");
        assert_ne!(words(&count(), "https://other.example", "Robin", &"b".repeat(64), &key), "basil tower reef smoke scarf");
    }

    #[test]
    fn base64_is_canonical_only() {
        assert_eq!(base64_bytes("AAAA"), Some(vec![0, 0, 0]));
        assert_eq!(base64_bytes("AA=="), Some(vec![0]));
        assert_eq!(base64_bytes("AB=="), None); // Stray bits.
        assert_eq!(base64_bytes("AAA"), None);
        assert_eq!(base64_bytes("A=AA"), None);
        assert_eq!(base64_bytes("AA-_"), None); // base64url is not this.
        assert_eq!(base64_bytes(""), None);
    }

    #[test]
    fn the_words_are_typed_five_wrong_end_it_and_enrol_hands_over_the_secret_once() {
        let now = Instant::now();
        let mut enrolment = Enrolment::default();
        let id = enrolment.offer(link(count()), now).unwrap();
        // One at a time.
        assert_eq!(enrolment.offer(link([0; 32]), now), Err(Refused::Busy));
        assert!(!enrolment.matches("basil tower reef smoke", now));
        assert!(enrolment.matches("  BASIL tower, reef-smoke  scarf ", now));
        assert_eq!(enrolment.verify("wrong words here", now), Err(Refused::Wrong { left: 4 }));
        // The view never carries the words or the secret.
        let view = enrolment.view(now).to_string();
        assert!(!view.contains("basil") && !view.contains("secret"));
        assert_eq!(enrolment.verify("basil tower reef smoke scarf", now), Ok(id));
        // Not before the policy was read.
        assert_eq!(enrolment.confirm(true, &[], now).err(), Some(Refused::Nothing));
        enrolment.policy(id, policy());
        assert_eq!(enrolment.view(now)["harnesses"][0], json!({ "harness": "claude", "label": "Claude Code", "detected": true, "allowed": false }));
        assert_eq!(enrolment.confirm(true, &["exec".into()], now).err(), Some(Refused::Harness));
        // Refused before anything was handed over: the secret is still there.
        assert_eq!(enrolment.pending.as_ref().unwrap().link.secret, count());
        let handover = enrolment.confirm(true, &["codex".into(), "claude".into()], now).unwrap();
        assert_eq!(handover.id, id);
        let args = handover.args.join(" ");
        assert!(args.starts_with("person control-enrol --origin https://rooms.example --name Robin --device "));
        assert!(args.ends_with("--trusted yes --allow claude,codex"));
        assert!(!args.contains("basil") && !args.contains(&crate::pair::encode(&count())));
        assert_eq!(String::from_utf8(handover.input).unwrap(), format!("{}\nbasil tower reef smoke scarf\n", crate::pair::encode(&count())));
        // Handed over once: the link no longer holds the secret, and Enrol can't be pressed again.
        assert_eq!(enrolment.confirm(true, &[], now).err(), Some(Refused::Nothing));
        assert_eq!(enrolment.pending.as_ref().unwrap().link.secret, [0; 32]);
        // While it is sent, nothing else waits; then the answer.
        assert_eq!(enrolment.offer(link([0; 32]), now), Err(Refused::Busy));
        enrolment.sent(id, Ok(json!({})));
        assert_eq!(enrolment.view(now)["stage"], "done");
        assert!(enrolment.offer(link([0; 32]), now).is_ok());
    }

    #[test]
    fn five_wrong_tries_end_it_it_expires_and_a_policy_it_could_not_read_is_left_alone() {
        let now = Instant::now();
        let mut enrolment = Enrolment::default();
        enrolment.offer(link(count()), now).unwrap();
        for left in (1..MAX_WRONG).rev() {
            assert_eq!(enrolment.verify("not it", now), Err(Refused::Wrong { left }));
        }
        assert_eq!(enrolment.verify("not it", now), Err(Refused::Ended));
        assert_eq!(enrolment.view(now)["stage"], "none");
        // Expired after 15 minutes.
        enrolment.offer(link(count()), now).unwrap();
        assert_eq!(enrolment.verify("basil tower reef smoke scarf", now + PENDING_FOR), Err(Refused::Expired));
        // A policy that couldn't be read: Enrol sends no --allow.
        let id = enrolment.offer(link(count()), now).unwrap();
        enrolment.verify("basil tower reef smoke scarf", now).unwrap();
        enrolment.policy(id, None);
        let handover = enrolment.confirm(false, &["claude".into()], now).unwrap();
        assert!(handover.args.join(" ").ends_with("--trusted no"));
        enrolment.sent(id, Err("The words don't match.\nsecond line".into()));
        assert_eq!(enrolment.view(now)["problem"], "The words don't match. second line");
        // Rejecting drops a waiting one, never one under way.
        let id = enrolment.offer(link(count()), now).unwrap();
        enrolment.reject();
        assert_eq!(enrolment.view(now)["stage"], "none");
        let _ = id;
    }

    #[test]
    fn allow_is_sent_only_when_the_person_changed_the_ticks_and_a_failed_one_is_replaced() {
        let now = Instant::now();
        let mut enrolment = Enrolment::default();
        let go = |enrolment: &mut Enrolment, policy: Option<Policy>, allow: &[&str]| {
            let id = enrolment.offer(link(count()), now).unwrap();
            enrolment.verify("basil tower reef smoke scarf", now).unwrap();
            enrolment.policy(id, policy);
            let args = enrolment.confirm(false, &allow.iter().map(|h| h.to_string()).collect::<Vec<_>>(), now).unwrap().args.join(" ");
            enrolment.sent(id, Err("stopped".into()));
            args
        };
        // As shown: nothing to change.
        assert!(go(&mut enrolment, on(&["claude"]), &["claude"]).ends_with("--trusted no"));
        // Changed: sent, in the window's order.
        assert!(go(&mut enrolment, on(&["claude"]), &["codex", "claude"]).ends_with("--allow claude,codex"));
        assert!(go(&mut enrolment, on(&["claude"]), &[]).ends_with("--allow none"));
        // Off, with nothing ticked: still off, and nothing sent.
        assert!(go(&mut enrolment, policy(), &[]).ends_with("--trusted no"));
        // Each of those ended Failed, and the next link replaced it.
        assert_eq!(enrolment.view(now)["stage"], "failed");
    }

    #[test]
    fn the_harnesses_are_the_daemons_and_the_window_may_call_its_six_commands_only() {
        let source = include_str!("../../../server/remote-control.ts");
        assert!(source.contains("export const REMOTE_HARNESSES = ['claude', 'codex', 'hermes', 'agy'] as const;"));
        assert_eq!(HARNESSES, ["claude", "codex", "hermes", "agy"]);
        let capability: Value = serde_json::from_str(include_str!("../capabilities/control.json")).unwrap();
        assert_eq!(capability["windows"], json!([WINDOW]));
        assert_eq!(capability["permissions"], json!(["allow-control-view", "allow-control-check", "allow-control-verify", "allow-control-confirm", "allow-control-reject", "allow-control-close"]));
    }

    #[test]
    fn the_policy_answer_is_read_strictly() {
        let answer = json!({ "policy": { "enabled": true, "harnesses": ["claude", "exec"], "trusted": [] },
            "harnesses": [{ "harness": "claude", "label": "Claude Code", "detected": true }, { "harness": "exec", "label": "Custom", "detected": true }] });
        let policy = read_policy(&answer).unwrap();
        assert!(policy.enabled);
        assert_eq!(policy.allowed, vec!["claude".to_string()]);
        assert_eq!(policy.harnesses, vec![("claude".to_string(), "Claude Code".to_string(), true)]);
        assert!(read_policy(&json!({})).is_none());
        // Off: nothing shows as allowed, whatever the file lists, so Enrol can't turn it on unasked.
        let off = read_policy(&json!({ "policy": { "enabled": false, "harnesses": ["claude"], "trusted": [] }, "harnesses": [] })).unwrap();
        assert!(!off.enabled);
        assert!(off.allowed.is_empty());
        // A policy the bridge couldn't read comes as null: unknown, not off.
        assert!(read_policy(&json!({ "policy": null, "harnesses": [] })).is_none());
    }
}
