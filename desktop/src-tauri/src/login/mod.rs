//! Start at login, with one owner (internal/docs/design/machine-daemon.md, "Lifecycle: one owner"). With the app, the
//! app's own login item starts the app and the app keeps the daemon running; headless, the bridge's own login item
//! (`meshrooms daemon install`, server/startup.ts) starts the daemon. Never both: to migrate a headless registration
//! the caller runs `enable` first and then `daemon uninstall` through `bridge::cli`, so a failed `enable` removes
//! nothing, and a failed uninstall leaves `state` at `Headless`, offering the move again. The daemon's lock is the
//! backstop.
//!
//! Shared contract, one implementation per platform:
//! - `state(app)`: `Headless` whenever the bridge's daemon login item is registered (even beside the app's, so the
//!   migration is offered again), else `App` when the app's login item starts exactly `app`, else `Off`.
//! - `enable(app)`: registers the app's login item for `app`, started in the background (no window). Idempotent, and it
//!   works while the bridge's own item is still registered (the caller removes that right after).
//! - `disable()`: removes the app's login item; never touches the bridge's.

use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginState {
    /// The app's own login item starts this app.
    App,
    /// The bridge's daemon login item is registered.
    Headless,
    Off,
}

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;

#[cfg(not(any(windows, target_os = "macos")))]
mod other;
#[cfg(not(any(windows, target_os = "macos")))]
use other as platform;

pub fn state(app: &Path) -> Result<LoginState, String> {
    platform::state(app)
}

/// Idempotent. To migrate a headless registration the caller then runs `daemon uninstall` via `bridge::cli`.
pub fn enable(app: &Path) -> Result<(), String> {
    platform::enable(app)
}

pub fn disable() -> Result<(), String> {
    platform::disable()
}
