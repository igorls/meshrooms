//! Untrusted deep links stop at a native window; nothing here acts on its own.
//! `join` goes to join.rs: a room this computer is already in opens, and anything else waits for the person in the join
//! window. `pair` opens the pairing window (pair.rs), where the person types the phrase their browser shows before
//! anything happens.
//! Do not derive Debug/Serialize for requests or retain/log raw links: a pair link carries the browser's secret.

use url::Url;

const MAX_LINK: usize = 8192;
/// A pairing link is at most 4 KB: 64 rooms and a name fit well within it.
const MAX_PAIR_LINK: usize = 4096;
const MAX_ORIGIN: usize = 512;
pub const MAX_PAIR_ROOMS: usize = 64;
/// A pairing link's name, in characters, once cleaned (src/browser/pairing.ts caps it the same way).
pub const MAX_NAME: usize = 64;

pub enum Request {
    Join { origin: String, room: String },
    /// From the person's browser (src/browser/pairing.ts). The secret goes straight into the pending pairing, which
    /// wipes it when it ends; it is never logged, shown, or put on a command line.
    Pair { origin: String, name: String, device: String, rooms: Vec<String>, secret: [u8; 32] },
}

#[derive(Debug, PartialEq, Eq)]
pub enum Invalid {
    Shape,
    Length,
    Query,
    Origin,
    Room,
    Version,
    Name,
    Secret,
    Device,
}

/// Parse without I/O, resolving names, or changing device/daemon state.
pub fn parse(raw: &str) -> Result<Request, Invalid> {
    if raw.len() > MAX_LINK {
        return Err(Invalid::Length);
    }
    if !raw.is_ascii()
        || raw
            .bytes()
            .any(|b| b.is_ascii_control() || b == b' ' || b == b'\\')
    {
        return Err(Invalid::Shape);
    }
    let rest = raw.strip_prefix("meshrooms://").ok_or(Invalid::Shape)?;
    let (action, query) = rest.split_once('?').ok_or(Invalid::Shape)?;
    if !matches!(action, "join" | "pair") || query.is_empty() || query.contains('#') {
        return Err(Invalid::Shape);
    }
    // Reject malformed escapes before the URL library's forgiving form decoder.
    let bytes = query.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit()
            {
                return Err(Invalid::Query);
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    if action == "pair" {
        if raw.len() > MAX_PAIR_LINK {
            return Err(Invalid::Length);
        }
        // Another version is refused as such, whatever fields it has (v=1 had no device and is no longer taken).
        if query.split('&').any(|item| item.starts_with("v=") && item != "v=2") {
            return Err(Invalid::Version);
        }
        let [version, origin, name, device, rooms, secret] = fields(query, ["v", "origin", "name", "device", "rooms", "secret"])?;
        if version != "2" {
            return Err(Invalid::Version);
        }
        validate_origin(&origin)?;
        // The browser's device id: only that browser device can link what this pairing asks (pairing.ts).
        if device.len() != 64 || !device.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(Invalid::Device);
        }
        // Controls, bidi overrides and invisible formatting go; whitespace collapses; long names are cut.
        let name = crate::text::clean(&name, MAX_NAME);
        if name.is_empty() {
            return Err(Invalid::Name);
        }
        let mut list: Vec<String> = Vec::new();
        for room in rooms.split(',') {
            if !room_id(room) {
                return Err(Invalid::Room);
            }
            if !list.iter().any(|known| known == room) {
                list.push(room.to_string());
            }
        }
        if list.len() > MAX_PAIR_ROOMS {
            return Err(Invalid::Room);
        }
        let secret = decode_secret(&secret).ok_or(Invalid::Secret)?;
        return Ok(Request::Pair { origin, name, device, rooms: list, secret });
    }
    let [origin, room] = fields(query, ["origin", "room"])?;
    validate_origin(&origin)?;
    if !room_id(&room) {
        return Err(Invalid::Room);
    }
    Ok(Request::Join { origin, room })
}

/// Each of `keys` exactly once, nothing else. Keys must be literal, preventing encoded aliases and duplicate bypasses.
/// Only a pairing's name may be other than ASCII (it is a person's name, and is cleaned for display); every other value
/// is plain ASCII without control characters. A value that isn't UTF-8 once decoded is refused, never repaired.
fn fields<const N: usize>(query: &str, keys: [&str; N]) -> Result<[String; N], Invalid> {
    let mut values: [Option<String>; N] = std::array::from_fn(|_| None);
    for item in query.split('&') {
        let (key, _) = item.split_once('=').ok_or(Invalid::Query)?;
        let at = keys.iter().position(|known| *known == key).ok_or(Invalid::Query)?;
        let mut pairs = url::form_urlencoded::parse(item.as_bytes());
        let (_, value) = pairs.next().ok_or(Invalid::Query)?;
        let text = key == "name";
        if value.is_empty()
            || value.contains(char::REPLACEMENT_CHARACTER)
            || (!text && (!value.is_ascii() || value.bytes().any(|b| b.is_ascii_control())))
        {
            return Err(Invalid::Query);
        }
        if values[at].replace(value.into_owned()).is_some() {
            return Err(Invalid::Query);
        }
    }
    let mut out: [String; N] = std::array::from_fn(|_| String::new());
    for (slot, value) in out.iter_mut().zip(values) {
        *slot = value.ok_or(Invalid::Query)?;
    }
    Ok(out)
}

/// A room id as the room service makes them: a lowercase UUID.
fn room_id(room: &str) -> bool {
    room.len() == 36
        && room.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

/// 32 bytes as base64url without padding: exactly 43 characters, the last one's unused bits zero (one spelling only).
fn decode_secret(text: &str) -> Option<[u8; 32]> {
    if text.len() != 43 {
        return None;
    }
    let mut out = [0u8; 32];
    let (mut bits, mut count, mut at) = (0u32, 0u32, 0usize);
    for c in text.bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        } as u32;
        bits = (bits << 6) | value;
        count += 6;
        if count >= 8 {
            count -= 8;
            if at == 32 {
                return None;
            }
            out[at] = (bits >> count) as u8;
            at += 1;
            bits &= (1 << count) - 1;
        }
    }
    (at == 32 && bits == 0).then_some(out)
}

fn validate_origin(origin: &str) -> Result<(), Invalid> {
    if origin.len() > MAX_ORIGIN {
        return Err(Invalid::Length);
    }
    let url = Url::parse(origin).map_err(|_| Invalid::Origin)?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.origin().ascii_serialization() != origin
    {
        return Err(Invalid::Origin);
    }
    Ok(())
}

pub fn route(app: &tauri::AppHandle, raw: &str) {
    match parse(raw) {
        Ok(Request::Pair { origin, name, device, rooms, secret }) => crate::pair::open(app, origin, name, device, rooms, secret),
        Ok(Request::Join { origin, room }) => crate::join::open(app, origin, room),
        Err(_) => {
            notice_limited(app, "Unsupported or invalid Meshrooms link. No action was taken.");
        }
    }
}

/// How often a refused link may show a notice: a page firing links in a loop must not keep taking the focus.
pub const NOTICE_EVERY: std::time::Duration = std::time::Duration::from_secs(10);

/// Whether a notice is due at `now`, given when the last one showed (updated when it is).
fn notice_due(last: &mut Option<std::time::Instant>, now: std::time::Instant) -> bool {
    if last.is_some_and(|at| now.duration_since(at) < NOTICE_EVERY) {
        return false;
    }
    *last = Some(now);
    true
}

/// `notice`, at most once per `NOTICE_EVERY` across refused links. Returns whether it showed.
pub fn notice_limited(app: &tauri::AppHandle, detail: &str) -> bool {
    static LAST: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    let due = notice_due(&mut LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()), std::time::Instant::now());
    if due {
        notice(app, detail);
    }
    due
}

/// A short, inert notice in its own window. The bundled page renders `detail` as text, not markup; never pass a URL.
pub fn notice(app: &tauri::AppHandle, detail: &str) {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    // Separate from the polling tray status, which would overwrite an approval notice.
    let mut page = super::app_origin(app)
        .join("index.html")
        .expect("static path");
    page.query_pairs_mut().append_pair("detail", detail);
    let window = match app.get_webview_window("link-approval") {
        Some(window) => window,
        None => match WebviewWindowBuilder::new(
            app,
            "link-approval",
            WebviewUrl::App("index.html".into()),
        )
        .title("Meshrooms — approval needed")
        .inner_size(560.0, 300.0)
        .build()
        {
            Ok(window) => window,
            Err(_) => return, // Never expose a URL-bearing error.
        },
    };
    let _ = window.navigate(page);
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;
    const ROOM: &str = "00000000-0000-4000-8000-000000000001";
    const ROOM2: &str = "00000000-0000-4000-8000-000000000002";
    const ZERO: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const DEVICE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    fn join(origin: &str) -> String {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("origin", origin)
            .append_pair("room", ROOM)
            .finish();
        format!("meshrooms://join?{query}")
    }
    /// A pair link as the browser makes it (URLSearchParams: spaces as +, commas escaped).
    fn pair(fields: &[(&str, &str)]) -> String {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        for (key, value) in fields {
            query.append_pair(key, value);
        }
        format!("meshrooms://pair?{}", query.finish())
    }
    fn good_pair() -> Vec<(&'static str, String)> {
        vec![
            ("v", "2".into()),
            ("origin", "https://rooms.example".into()),
            ("name", "Robin Lee".into()),
            ("device", DEVICE.into()),
            ("rooms", format!("{ROOM},{ROOM2}")),
            ("secret", ZERO.into()),
        ]
    }
    fn with(changes: &[(&'static str, Option<String>)]) -> String {
        let mut fields = good_pair();
        for (key, value) in changes {
            fields.retain(|(k, _)| k != key);
            if let Some(value) = value {
                fields.push((key, value.clone()));
            }
        }
        pair(&fields.iter().map(|(k, v)| (*k, v.as_str())).collect::<Vec<_>>())
    }
    #[test]
    fn refused_links_show_one_notice_per_interval() {
        let (mut last, now) = (None, std::time::Instant::now());
        assert!(notice_due(&mut last, now));
        for step in 1..1000u32 {
            assert!(!notice_due(&mut last, now + NOTICE_EVERY * step / 1000), "a flood within the interval shows nothing more");
        }
        assert!(notice_due(&mut last, now + NOTICE_EVERY));
        assert!(!notice_due(&mut last, now + NOTICE_EVERY));
    }
    #[test]
    fn join_is_typed() {
        let request = parse(&join("https://rooms.example")).expect("valid join");
        match &request {
            Request::Join { origin, room } => {
                assert_eq!(origin, "https://rooms.example");
                assert_eq!(room, ROOM);
            }
            Request::Pair { .. } => panic!("a join link is a join"),
        }
    }
    #[test]
    fn a_join_link_as_the_hosted_page_builds_it() {
        // src/browser/desktop-join.ts: URLSearchParams of origin and room, the origin's slashes and colon escaped.
        for (origin, encoded) in [
            ("https://meshrooms.wormdb.dev", "https%3A%2F%2Fmeshrooms.wormdb.dev"),
            ("http://127.0.0.1:4317", "http%3A%2F%2F127.0.0.1%3A4317"),
        ] {
            match parse(&format!("meshrooms://join?origin={encoded}&room={ROOM}")) {
                Ok(Request::Join { origin: parsed, room }) => assert_eq!((parsed.as_str(), room.as_str()), (origin, ROOM)),
                _ => panic!("{origin}"),
            }
        }
        // Fields in either order; anything more, or a room in another shape, is refused.
        assert!(parse(&format!("meshrooms://join?room={ROOM}&origin=https%3A%2F%2Frooms.example")).is_ok());
        assert_eq!(parse(&format!("meshrooms://join?origin=https%3A%2F%2Frooms.example&room={ROOM}&name=x")).err(), Some(Invalid::Query));
        assert_eq!(parse("meshrooms://join?origin=https%3A%2F%2Frooms.example&room=0000000A-0000-4000-8000-000000000001").err(), Some(Invalid::Room));
        assert_eq!(parse(&format!("meshrooms://join?origin=https%3A%2F%2Frooms.example%2F&room={ROOM}")).err(), Some(Invalid::Origin));
    }
    #[test]
    fn canonical_origins_and_loopback_only_plain_http() {
        for good in [
            "https://rooms.example",
            "https://rooms.example:8443",
            "http://localhost:4310",
            "http://127.0.0.1:4310",
            "http://[::1]:4310",
        ] {
            assert!(parse(&join(good)).is_ok());
            assert!(parse(&with(&[("origin", Some(good.into()))])).is_ok(), "{good}");
        }
        for bad in [
            "http://rooms.example",
            "file:///tmp",
            "https://user:pass@rooms.example",
            "https://rooms.example/path",
            "https://rooms.example?nonce=fixture",
            "https://rooms.example#fixture",
            "https://rooms.example/",
            "https://rooms.example:443",
            "https://ROOMS.example",
            "http://127.1:4310",
            "http://localhost.evil:4310",
            "https://rooms.example/../",
            "https://rooms.example%2f.evil",
        ] {
            assert!(parse(&join(bad)).is_err());
            assert!(parse(&with(&[("origin", Some(bad.into()))])).is_err(), "{bad}");
        }
    }
    #[test]
    fn unsupported_authorities_paths_and_fragments() {
        for bad in [
            "https://join?x=y",
            "meshrooms:join?x=y",
            "meshrooms:///join?x=y",
            "meshrooms://JOIN?x=y",
            "meshrooms://user@join?x=y",
            "meshrooms://join:1?x=y",
            "meshrooms://join/?x=y",
            "meshrooms://other?x=y",
            "meshrooms://join?x=y#fragment",
            "meshrooms://join?x=\n",
            "meshrooms://join?x=\\",
            "meshrooms://join?x=é",
            "meshrooms://pair/?v=2",
            "meshrooms://PAIR?v=2",
        ] {
            assert!(parse(bad).is_err());
        }
    }
    #[test]
    fn duplicate_unknown_empty_and_bad_encoding_fields() {
        let valid = join("https://rooms.example");
        for suffix in [
            "&origin=https://evil.example",
            "&room=other",
            "&nonce=fixture",
            "&%72oom=other",
            "&",
            "&origin",
            "&room=%",
            "&room=%GG",
            "&room=%FF",
            "&room=%00",
        ] {
            assert!(parse(&format!("{valid}{suffix}")).is_err());
        }
        for bad in [
            "meshrooms://join?origin=",
            "meshrooms://join?room=",
            "meshrooms://join?origin=https%3A%2F%2Frooms.example",
            "meshrooms://join?room=not-a-room&origin=https%3A%2F%2Frooms.example",
        ] {
            assert!(parse(bad).is_err());
        }
        let valid = with(&[]);
        for suffix in ["&v=2", "&device=x", "&secret=AAAA", "&nonce=x", "&%76=1", "&", "&name", "&name=%FF", "&rooms=%"] {
            assert!(parse(&format!("{valid}{suffix}")).is_err(), "{suffix}");
        }
    }
    #[test]
    fn lengths_and_room_shape() {
        assert_eq!(parse(&"x".repeat(MAX_LINK + 1)).err(), Some(Invalid::Length));
        assert!(parse(&join(&format!("https://{}.example", "a".repeat(MAX_ORIGIN)))).is_err());
        let valid = join("https://rooms.example");
        for room in [
            "",
            "../fixture",
            "000000000000400080000000000000000001",
            "00000000-0000-4000-8000-00000000000G",
            "00000000-0000-4000-8000-00000000000A",
        ] {
            assert!(parse(&valid.replace(ROOM, room)).is_err());
        }
    }
    #[test]
    fn a_pair_link_is_typed_with_its_rooms_deduplicated_and_its_secret_decoded() {
        let link = with(&[("rooms", Some(format!("{ROOM},{ROOM2},{ROOM}")))]);
        match parse(&link).expect("valid pair") {
            Request::Pair { origin, name, device, rooms, secret } => {
                assert_eq!(device, DEVICE);
                assert_eq!(origin, "https://rooms.example");
                assert_eq!(name, "Robin Lee");
                assert_eq!(rooms, vec![ROOM.to_string(), ROOM2.to_string()]);
                assert_eq!(secret, [0u8; 32]);
            }
            Request::Join { .. } => panic!("a pair link is a pair"),
        }
        // The browser's encoding of 0..31 (src/browser/pairing.test.ts).
        match parse(&with(&[("secret", Some("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8".into()))])).expect("valid") {
            Request::Pair { secret, .. } => assert_eq!(secret.to_vec(), (0u8..32).collect::<Vec<_>>()),
            Request::Join { .. } => panic!("a pair link is a pair"),
        }
    }
    #[test]
    fn a_pair_link_refuses_other_versions_secrets_and_room_lists() {
        let refused = |changes: &[(&'static str, Option<String>)]| parse(&with(changes)).err();
        assert_eq!(refused(&[("v", Some("1".into()))]), Some(Invalid::Version));
        assert_eq!(refused(&[("v", Some("3".into()))]), Some(Invalid::Version));
        assert_eq!(parse(&pair(&[("v", "1"), ("origin", "https://rooms.example"), ("name", "Robin"), ("rooms", ROOM), ("secret", ZERO)])).err(), Some(Invalid::Version), "a v=1 link is refused");
        for device in ["", "b", &"B".repeat(64), &"b".repeat(63), &"g".repeat(64)] {
            assert!(refused(&[("device", Some(device.to_string()))]).is_some(), "{device}");
        }
        for missing in ["v", "origin", "name", "device", "rooms", "secret"] {
            assert_eq!(refused(&[(missing, None)]), Some(Invalid::Query), "{missing}");
        }
        for secret in [&ZERO[1..], &format!("{ZERO}A")[..], "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="] {
            assert!(refused(&[("secret", Some(secret.into()))]).is_some(), "{secret}");
        }
        assert_eq!(refused(&[("rooms", Some(format!("{ROOM},not-a-room")))]), Some(Invalid::Room));
        assert_eq!(refused(&[("rooms", Some(format!("{ROOM},")))]), Some(Invalid::Room));
        let many: Vec<String> = (0..=MAX_PAIR_ROOMS).map(|i| format!("00000000-0000-4000-8000-{i:012x}")).collect();
        assert_eq!(refused(&[("rooms", Some(many.join(",")))]), Some(Invalid::Room));
        let most: Vec<String> = (0..MAX_PAIR_ROOMS).map(|i| format!("00000000-0000-4000-8000-{i:012x}")).collect();
        assert!(parse(&with(&[("rooms", Some(most.join(",")))])).is_ok(), "64 rooms fit in a pairing link");
        assert_eq!(refused(&[("name", Some(format!("{}x", "y".repeat(5000))))]), Some(Invalid::Length));
    }
    #[test]
    fn a_pair_name_loses_controls_and_bidi_overrides_and_is_capped() {
        let rlo = char::from_u32(0x202E).unwrap();
        let bell = char::from_u32(7).unwrap();
        let name = |raw: String| match parse(&with(&[("name", Some(raw))])) {
            Ok(Request::Pair { name, .. }) => Ok(name),
            Ok(Request::Join { .. }) => panic!("a pair link is a pair"),
            Err(error) => Err(error),
        };
        assert_eq!(name(format!("Ro{rlo}bin{bell}\n Lee")).unwrap(), "Robin Lee");
        assert_eq!(name("Zoë Ångström".into()).unwrap(), "Zoë Ångström");
        assert_eq!(name("é".repeat(100)).unwrap().chars().count(), MAX_NAME);
        assert_eq!(name(format!("{rlo}{bell}")).err(), Some(Invalid::Name));
    }
}
