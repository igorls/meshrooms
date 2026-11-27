//! Windows: a per-user Run key value. The app's is `Meshrooms` = `"<app exe>" --background`; the bridge's headless one
//! is `meshrooms-daemon` (server/agent-cli.ts daemonLoginItem), which starts a hidden PowerShell script. Both live under
//! HKCU, so no elevation is ever needed.
//!
//! Values are read and written through the registry API, in UTF-16, never by parsing `reg.exe` output: reg.exe prints
//! in the console's OEM code page (850 on a default Portuguese or Western European Windows), so a path with
//! an accent (a profile folder named João, say) came back garbled, never matched, and Start at login always looked off.

use super::LoginState;
use std::io;
use std::path::Path;
use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE};
use winreg::{RegKey, RegValue};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APP_VALUE: &str = "Meshrooms";
const HEADLESS_VALUE: &str = "meshrooms-daemon";

/// The app's Run value name. Debug builds take `MESHROOMS_DEV_LOGIN_VALUE`, so a development app can be tested with a
/// throwaway value and never touch an installed app's entry.
fn app_value() -> String {
    #[cfg(debug_assertions)]
    if let Some(name) = std::env::var("MESHROOMS_DEV_LOGIN_VALUE").ok().filter(|name| !name.is_empty() && !name.eq_ignore_ascii_case(HEADLESS_VALUE)) {
        return name;
    }
    APP_VALUE.to_string()
}

/// What the app's Run value starts: this exe, in the background (tray only, no window).
fn command(app: &Path) -> String {
    format!("\"{}\" --background", app.display())
}

/// The Run key, opened to read values, or also to change them.
fn run_key(write: bool) -> io::Result<RegKey> {
    let access = if write { KEY_QUERY_VALUE | KEY_SET_VALUE } else { KEY_QUERY_VALUE };
    RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, access)
}

/// The text of a string value: UTF-16LE, ending at its first NUL (the stored terminator, when there is one).
/// Anything but REG_SZ or REG_EXPAND_SZ is not a command line, so it counts as no value.
fn text_of(value: &RegValue) -> Option<String> {
    if !matches!(value.vtype, RegType::REG_SZ | RegType::REG_EXPAND_SZ) {
        return None;
    }
    let units: Vec<u16> = value.bytes.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).take_while(|unit| *unit != 0).collect();
    String::from_utf16(&units).ok()
}

fn query(name: &str) -> Result<Option<String>, String> {
    let key = match run_key(false) {
        Ok(key) => key,
        // A profile that never had a Run key has no entries in it.
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read the Windows startup entries: {error}")),
    };
    match key.get_raw_value(name) {
        Ok(value) => Ok(text_of(&value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot read the Windows startup entry {name}: {error}")),
    }
}

fn set(name: &str, data: &str) -> Result<(), String> {
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey_with_flags(RUN_KEY, KEY_QUERY_VALUE | KEY_SET_VALUE)
        .map_err(|error| format!("Windows could not register Meshrooms to start at login: {error}"))?;
    key.set_value(name, &data.to_string()).map_err(|error| format!("Windows could not register Meshrooms to start at login: {error}"))?;
    if query(name)?.as_deref() != Some(data) {
        return Err("Windows could not register Meshrooms to start at login.".into());
    }
    Ok(())
}

fn remove(name: &str) -> Result<(), String> {
    if query(name)?.is_some() {
        let key = run_key(true).map_err(|error| format!("Windows could not remove the Meshrooms startup entry: {error}"))?;
        match key.delete_value(name) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Windows could not remove the Meshrooms startup entry: {error}")),
        }
    }
    match query(name)? {
        Some(_) => Err("Windows could not remove the Meshrooms startup entry.".into()),
        None => Ok(()),
    }
}

fn classify(app: Option<&str>, headless: bool, expected: &str) -> LoginState {
    if headless {
        LoginState::Headless
    } else if app.is_some_and(|data| data.eq_ignore_ascii_case(expected)) {
        LoginState::App
    } else {
        LoginState::Off
    }
}

pub fn state(app: &Path) -> Result<LoginState, String> {
    Ok(classify(query(&app_value())?.as_deref(), query(HEADLESS_VALUE)?.is_some(), &command(app)))
}

pub fn enable(app: &Path) -> Result<(), String> {
    set(&app_value(), &command(app))
}

pub fn disable() -> Result<(), String> {
    remove(&app_value())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(text: &str, terminator: bool) -> Vec<u8> {
        let mut units: Vec<u16> = text.encode_utf16().collect();
        if terminator {
            units.push(0);
        }
        units.iter().flat_map(|unit| unit.to_le_bytes()).collect()
    }

    #[test]
    fn string_values_are_read_as_utf16_up_to_their_terminator() {
        let data = "\"C:\\Apps\\Ação Ñandú\\Meshrooms\\Meshrooms.exe\" --background";
        let value = |bytes, vtype| RegValue { bytes, vtype };
        assert_eq!(text_of(&value(utf16(data, true), RegType::REG_SZ)).as_deref(), Some(data));
        assert_eq!(text_of(&value(utf16(data, false), RegType::REG_SZ)).as_deref(), Some(data), "a value stored without its NUL");
        assert_eq!(text_of(&value(utf16("%LOCALAPPDATA%\\x.exe", true), RegType::REG_EXPAND_SZ)).as_deref(), Some("%LOCALAPPDATA%\\x.exe"));
        assert_eq!(text_of(&value(vec![1, 0, 0, 0], RegType::REG_DWORD)), None);
        assert_eq!(text_of(&value(utf16("a", true), RegType::REG_MULTI_SZ)), None);
        assert_eq!(text_of(&value(Vec::new(), RegType::REG_SZ)).as_deref(), Some(""));
    }

    #[test]
    fn the_app_entry_must_start_this_exe_and_headless_wins() {
        let app = Path::new(r"C:\Program Files\Meshrooms\Meshrooms.exe");
        let expected = command(app);
        assert_eq!(expected, "\"C:\\Program Files\\Meshrooms\\Meshrooms.exe\" --background");
        assert_eq!(classify(Some(&expected), false, &expected), LoginState::App);
        assert_eq!(classify(Some(&expected.to_uppercase()), false, &expected), LoginState::App);
        assert_eq!(classify(Some("\"D:\\Old\\Meshrooms.exe\" --background"), false, &expected), LoginState::Off);
        assert_eq!(classify(None, false, &expected), LoginState::Off);
        assert_eq!(classify(None, true, &expected), LoginState::Headless);
        assert_eq!(classify(Some(&expected), true, &expected), LoginState::Headless);
        let accented = command(Path::new(r"C:\Apps\João\Meshrooms\Meshrooms.exe"));
        assert_eq!(classify(Some(&accented), false, &accented), LoginState::App);
    }

    /// Writes and removes a throwaway Run value (never `Meshrooms` or `meshrooms-daemon`), with a non-ASCII path, the
    /// case reg.exe's code page broke. Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn round_trips_a_throwaway_run_value() {
        let name = format!("MeshroomsTest-{}", std::process::id());
        let data = command(Path::new(r"C:\Apps\Ação Ñandú\Meshrooms Test\Meshrooms.exe"));
        let result = (|| {
            set(&name, &data)?;
            set(&name, &data)?;
            let read = query(&name)?;
            remove(&name)?;
            remove(&name)?;
            Ok::<_, String>((read, query(&name)?))
        })();
        if let Ok(key) = run_key(true) {
            let _ = key.delete_value(&name);
        }
        let (read, after) = result.unwrap();
        assert_eq!(read.as_deref(), Some(data.as_str()));
        assert_eq!(after, None);
    }
}
