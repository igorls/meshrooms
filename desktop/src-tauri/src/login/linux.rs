//! Linux app login registration: an XDG Autostart desktop entry (`$XDG_CONFIG_HOME/autostart/` or
//! `~/.config/autostart/`) that starts the app with `--background`, while detecting the bridge's headless systemd user
//! unit (`systemd/user/meshrooms-daemon.service`, server/startup.ts) so migration follows the shared one-owner contract.

use super::LoginState;
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const APP_ENTRY: &str = "dev.wormdb.meshrooms.desktop";
const HEADLESS_SERVICE: &str = "meshrooms-daemon.service";

/// The app's autostart desktop entry stem. Debug builds take `MESHROOMS_DEV_LOGIN_VALUE` so checks never touch an
/// installed app's autostart file.
fn entry_name() -> String {
    #[cfg(debug_assertions)]
    if let Some(name) = std::env::var("MESHROOMS_DEV_LOGIN_VALUE").ok().filter(|name| {
        !name.is_empty()
            && !name.contains('/')
            && !name.contains('\\')
            && !name.contains("..")
            && !name.chars().any(char::is_control)
    }) {
        return name;
    }
    APP_ENTRY.to_string()
}

/// `$XDG_CONFIG_HOME` when set and absolute, else `<home>/.config` (XDG Base Directory Specification).
fn config_dir(home: &Path, xdg: Option<&OsStr>) -> PathBuf {
    xdg.map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".config"))
}

fn autostart_file(config: &Path, name: &str) -> PathBuf {
    config.join("autostart").join(format!("{name}.desktop"))
}

fn headless(config: &Path) -> bool {
    // Even a disabled systemd user unit keeps migration visible until caller-owned `daemon uninstall` removes it.
    config.join("systemd").join("user").join(HEADLESS_SERVICE).exists()
}

fn executable(app: &Path) -> Result<PathBuf, String> {
    let path = app
        .canonicalize()
        .map_err(|error| format!("Cannot resolve the application executable: {error}"))?;
    if !path.is_file() {
        return Err("The application executable is not a file.".into());
    }
    let text = path.to_str().ok_or("The application path is not valid UTF-8.")?;
    if text.chars().any(char::is_control) {
        return Err("The application path contains control characters.".into());
    }
    Ok(path)
}

/// Escapes an argument inside double quotes for a FreeDesktop `Exec=` line: desktop-entry string escaping (`\`)
/// layered over `Exec` quoting (`"`, `` ` ``, `$`, `\`) and field-code escaping (`%` -> `%%`).
fn exec_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '\\' => out.push_str(r"\\\\"),
            '"' => out.push_str(r#"\\""#),
            '`' => out.push_str(r"\\`"),
            '$' => out.push_str(r"\\$"),
            '%' => out.push_str("%%"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn desktop_entry(app: &Path) -> Result<String, String> {
    let path = executable(app)?;
    let exec = exec_quote(path.to_str().ok_or("The application path is not valid UTF-8.")?);
    Ok(format!(
        "[Desktop Entry]\n\
Type=Application\n\
Version=1.0\n\
Name=Meshrooms\n\
Comment=Keep Meshrooms rooms and agents connected\n\
Exec={exec} --background\n\
Terminal=false\n\
StartupNotify=false\n\
X-GNOME-Autostart-enabled=true\n"
    ))
}

fn app_state_at(config: &Path, app: &Path, name: &str) -> Result<LoginState, String> {
    let expected = desktop_entry(app)?;
    let actual = match fs::read_to_string(autostart_file(config, name)) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(LoginState::Off),
        Err(error) => return Err(format!("Cannot read the app login item: {error}")),
    };
    Ok(if actual == expected { LoginState::App } else { LoginState::Off })
}

fn state_at(config: &Path, app: &Path, name: &str) -> Result<LoginState, String> {
    if headless(config) {
        return Ok(LoginState::Headless);
    }
    app_state_at(config, app, name)
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing login item directory.")?;
    fs::create_dir_all(parent).map_err(|error| format!("Cannot create the login item directory: {error}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let tmp = parent.join(format!(".{APP_ENTRY}.{}.{nonce}.tmp", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o644)
            .open(&tmp)
            .map_err(|error| error.to_string())?;
        file.write_all(content).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&tmp, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result.map_err(|error| format!("Cannot save the app login item: {error}"))
}

fn enable_at(config: &Path, app: &Path, name: &str) -> Result<(), String> {
    let content = desktop_entry(app)?;
    let path = autostart_file(config, name);
    let previous = match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Cannot read the prior app login item: {error}")),
    };
    write_atomic(&path, content.as_bytes())?;
    let verified = app_state_at(config, app, name).and_then(|state| {
        if state == LoginState::App {
            Ok(())
        } else {
            Err("The app login registration could not be verified.".into())
        }
    });
    if let Err(error) = verified {
        let restored = match previous {
            Some(bytes) => write_atomic(&path, &bytes),
            None => match fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(err) => Err(format!("Cannot remove the new app login item: {err}")),
            },
        };
        return match restored {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!("{error}; rollback failed: {rollback}")),
        };
    }
    Ok(())
}

fn disable_at(config: &Path, name: &str) -> Result<(), String> {
    match fs::remove_file(autostart_file(config, name)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot remove the app login item: {error}")),
    }
}

fn current_config_dir() -> Result<PathBuf, String> {
    Ok(config_dir(&crate::runtime::home()?, std::env::var_os("XDG_CONFIG_HOME").as_deref()))
}

pub fn state(app: &Path) -> Result<LoginState, String> {
    state_at(&current_config_dir()?, app, &entry_name())
}

pub fn enable(app: &Path) -> Result<(), String> {
    enable_at(&current_config_dir()?, app, &entry_name())
}

pub fn disable() -> Result<(), String> {
    disable_at(&current_config_dir()?, &entry_name())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        config: PathBuf,
        app: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "mr-linux-login-{}-{}-{}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            let config = root.join("config");
            let app = root.join("bin").join("meshrooms-desktop");
            fs::create_dir_all(app.parent().unwrap()).unwrap();
            fs::write(&app, "#!/bin/sh\n").unwrap();
            Self { root, config, app }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn desktop_entry_is_valid_background_and_escapes_special_exec_characters() {
        let f = Fixture::new();
        let entry = desktop_entry(&f.app).unwrap();
        let canonical = f.app.canonicalize().unwrap();
        assert!(entry.starts_with("[Desktop Entry]\n"));
        assert!(entry.contains(&format!("Exec=\"{}\" --background\n", canonical.display())));
        assert!(entry.contains("Terminal=false\n"));
        assert!(entry.contains("X-GNOME-Autostart-enabled=true\n"));
        assert!(!entry.contains("daemon"));
        assert_eq!(exec_quote(r#"/opt/a "b" $c `d` \e 100%/app"#), r#""/opt/a \\"b\\" \\$c \\`d\\` \\\\e 100%%/app""#);
    }

    #[test]
    fn xdg_config_home_must_be_absolute_else_falls_back_to_dot_config() {
        let home = Path::new("/home/someone");
        assert_eq!(config_dir(home, None), PathBuf::from("/home/someone/.config"));
        assert_eq!(config_dir(home, Some(OsStr::new(""))), PathBuf::from("/home/someone/.config"));
        assert_eq!(config_dir(home, Some(OsStr::new("relative/config"))), PathBuf::from("/home/someone/.config"));
        assert_eq!(config_dir(home, Some(OsStr::new("/tmp/xdg"))), PathBuf::from("/tmp/xdg"));
    }

    #[test]
    fn enable_and_disable_are_idempotent_and_detect_other_executables_or_disabled_entries() {
        let f = Fixture::new();
        assert_eq!(state_at(&f.config, &f.app, APP_ENTRY).unwrap(), LoginState::Off);
        enable_at(&f.config, &f.app, APP_ENTRY).unwrap();
        enable_at(&f.config, &f.app, APP_ENTRY).unwrap();
        assert_eq!(state_at(&f.config, &f.app, APP_ENTRY).unwrap(), LoginState::App);

        let other = f.root.join("bin").join("meshrooms-other");
        fs::write(&other, "#!/bin/sh\n").unwrap();
        assert_eq!(state_at(&f.config, &other, APP_ENTRY).unwrap(), LoginState::Off);

        let path = autostart_file(&f.config, APP_ENTRY);
        let disabled = format!("{}Hidden=true\n", fs::read_to_string(&path).unwrap());
        fs::write(&path, disabled).unwrap();
        assert_eq!(state_at(&f.config, &f.app, APP_ENTRY).unwrap(), LoginState::Off);

        disable_at(&f.config, APP_ENTRY).unwrap();
        disable_at(&f.config, APP_ENTRY).unwrap();
        assert!(!path.exists());
        assert_eq!(state_at(&f.config, &f.app, APP_ENTRY).unwrap(), LoginState::Off);
    }

    #[test]
    fn headless_systemd_unit_takes_precedence_and_migration_never_removes_it_directly() {
        let f = Fixture::new();
        let unit = f.config.join("systemd").join("user").join(HEADLESS_SERVICE);
        fs::create_dir_all(unit.parent().unwrap()).unwrap();
        fs::write(&unit, "[Unit]\nDescription=Meshrooms\n").unwrap();

        assert_eq!(state_at(&f.config, &f.app, APP_ENTRY).unwrap(), LoginState::Headless);
        enable_at(&f.config, &f.app, APP_ENTRY).unwrap();
        assert!(autostart_file(&f.config, APP_ENTRY).is_file());
        assert!(unit.is_file(), "enable must never remove the headless unit itself");
        // Still Headless until the caller's `daemon uninstall` removes the unit.
        assert_eq!(state_at(&f.config, &f.app, APP_ENTRY).unwrap(), LoginState::Headless);

        // Once the caller removes the unit, state becomes App; disable leaves no autostart file.
        fs::remove_file(&unit).unwrap();
        assert_eq!(state_at(&f.config, &f.app, APP_ENTRY).unwrap(), LoginState::App);
        disable_at(&f.config, APP_ENTRY).unwrap();
        assert_eq!(state_at(&f.config, &f.app, APP_ENTRY).unwrap(), LoginState::Off);
    }

    #[test]
    fn missing_executable_or_unreadable_prior_entry_fails_cleanly() {
        let f = Fixture::new();
        assert!(enable_at(&f.config, &f.root.join("missing"), APP_ENTRY).is_err());
        assert!(!autostart_file(&f.config, APP_ENTRY).exists());

        // A directory at the autostart file path produces a deterministic read error before mutation.
        let path = autostart_file(&f.config, APP_ENTRY);
        fs::create_dir_all(&path).unwrap();
        let marker = path.join("untouched");
        fs::write(&marker, "original").unwrap();
        let error = enable_at(&f.config, &f.app, APP_ENTRY).unwrap_err();
        assert!(error.contains("Cannot read the prior app login item"));
        assert_eq!(fs::read_to_string(&marker).unwrap(), "original");
    }
}
