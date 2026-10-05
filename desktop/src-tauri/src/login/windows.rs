//! Windows: a per-user Run key value. The app's is `Meshrooms` = `"<app exe>" --background`; the bridge's headless one
//! is `meshrooms-daemon` (server/agent-cli.ts daemonLoginItem), which starts a hidden PowerShell script. Both live under
//! HKCU, so no elevation is ever needed. Values are read and written with %SystemRoot%\System32\reg.exe, run without a
//! console window.

use super::LoginState;
use crate::bridge::hidden;
use std::path::{Path, PathBuf};

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
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

/// reg.exe by its full path, never whatever a search of the working folder or PATH finds first.
fn reg_exe() -> PathBuf {
    let root = std::env::var_os("SystemRoot").filter(|root| !root.is_empty()).unwrap_or_else(|| r"C:\Windows".into());
    PathBuf::from(root).join("System32").join("reg.exe")
}

fn reg(args: &[&str]) -> Result<(bool, String), String> {
    let output = hidden(&reg_exe()).args(args).output().map_err(|error| format!("Cannot run reg.exe: {error}"))?;
    Ok((output.status.success(), String::from_utf8_lossy(&output.stdout).into_owned()))
}

/// The data of `name` in `reg query <key> /v <name>` output: a line `    <name>    REG_SZ    <data>`. Value names are
/// case-insensitive in the registry, so they are matched that way.
fn parse_value(stdout: &str, name: &str) -> Option<String> {
    stdout.lines().find_map(|line| {
        let line = line.trim_start();
        let rest = line.get(name.len()..).filter(|_| line.get(..name.len()).is_some_and(|start| start.eq_ignore_ascii_case(name)))?;
        let rest = rest.strip_prefix("    ")?.trim_start();
        let (kind, data) = rest.split_once("    ").unwrap_or((rest, ""));
        matches!(kind, "REG_SZ" | "REG_EXPAND_SZ").then(|| data.trim_start().trim_end_matches(['\r', '\n']).to_string())
    })
}

fn query(name: &str) -> Result<Option<String>, String> {
    let (found, stdout) = reg(&["query", RUN_KEY, "/v", name])?;
    // reg.exe exits 1 when the value does not exist.
    Ok(if found { parse_value(&stdout, name) } else { None })
}

fn set(name: &str, data: &str) -> Result<(), String> {
    let (done, _) = reg(&["add", RUN_KEY, "/v", name, "/t", "REG_SZ", "/d", data, "/f"])?;
    if !done || query(name)?.as_deref() != Some(data) {
        return Err("Windows could not register Meshrooms to start at login.".into());
    }
    Ok(())
}

fn remove(name: &str) -> Result<(), String> {
    if query(name)?.is_some() {
        reg(&["delete", RUN_KEY, "/v", name, "/f"])?;
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

    const QUERY: &str = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    Meshrooms    REG_SZ    \"C:\\Program Files\\Meshrooms\\Meshrooms.exe\" --background\r\n\r\n";

    #[test]
    fn parses_reg_query_output() {
        assert_eq!(parse_value(QUERY, "Meshrooms").as_deref(), Some("\"C:\\Program Files\\Meshrooms\\Meshrooms.exe\" --background"));
        let spaced = "    Docker Desktop    REG_SZ    C:\\Program Files\\Docker\\Docker Desktop.exe\r\n";
        assert_eq!(parse_value(spaced, "Docker Desktop").as_deref(), Some("C:\\Program Files\\Docker\\Docker Desktop.exe"));
        let headless = "    meshrooms-daemon    REG_SZ    \"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -NonInteractive -WindowStyle Hidden -File \"start-at-login.ps1\"\r\n";
        assert!(parse_value(headless, HEADLESS_VALUE).unwrap().ends_with("-File \"start-at-login.ps1\""));
        // A longer name that starts with the one asked for is another value.
        assert_eq!(parse_value("    Meshrooms-0123456789abcdef    REG_SZ    x\r\n", "Meshrooms"), None);
        assert_eq!(parse_value("    Meshrooms    REG_DWORD    0x1\r\n", "Meshrooms"), None);
        assert_eq!(parse_value("", "Meshrooms"), None);
        // reg.exe prints the name as stored; the registry ignores case.
        assert!(parse_value("    MESHROOMS-DAEMON    REG_SZ    x\r\n", HEADLESS_VALUE).is_some());
        assert_eq!(parse_value("    meshrooms    REG_SZ    y\r\n", "Meshrooms").as_deref(), Some("y"));
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
    }

    /// Writes and removes a throwaway Run value (never `Meshrooms` or `meshrooms-daemon`).
    /// Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn round_trips_a_throwaway_run_value() {
        let name = format!("MeshroomsTest-{}", std::process::id());
        let data = command(Path::new(r"C:\Program Files\Meshrooms Test\Meshrooms.exe"));
        let result = (|| {
            set(&name, &data)?;
            set(&name, &data)?;
            let read = query(&name)?;
            remove(&name)?;
            remove(&name)?;
            Ok::<_, String>((read, query(&name)?))
        })();
        let _ = reg(&["delete", RUN_KEY, "/v", &name, "/f"]);
        let (read, after) = result.unwrap();
        assert_eq!(read.as_deref(), Some(data.as_str()));
        assert_eq!(after, None);
    }
}
