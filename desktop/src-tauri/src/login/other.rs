//! Other systems (Linux): the app has no login item yet; `meshrooms daemon install` (a systemd user unit) is the way.

use super::LoginState;
use std::path::Path;

pub fn state(_app: &Path) -> Result<LoginState, String> {
    Ok(LoginState::Off)
}

pub fn enable(_app: &Path) -> Result<(), String> {
    Err("Start at login is not supported by the app on this system yet. Use `meshrooms daemon install`.".into())
}

pub fn disable() -> Result<(), String> {
    Ok(())
}
