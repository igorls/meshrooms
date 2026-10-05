//! macOS app login registration. LaunchServices opens the canonical application
//! hidden, so removing/disabling this one-shot job never terminates the active app.
//! No daemon, shell, or inherited environment is persisted in the registration.

use super::LoginState;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const LABEL: &str = "dev.wormdb.meshrooms.desktop.login";
const HEADLESS: &str = "dev.wormdb.meshrooms.agent-daemon";
type Run<'a> = dyn Fn(&[&str]) -> Result<String, String> + 'a;

extern "C" {
    fn geteuid() -> u32;
}

fn domain() -> String {
    // macOS GUI LaunchAgents belong to the current OS user's GUI domain.
    format!("gui/{}", unsafe { geteuid() })
}

fn launchctl(args: &[&str]) -> Result<String, String> {
    let result = Command::new("/bin/launchctl")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Cannot query the macOS login item: {e}"))?;
    if !result.status.success() {
        return Err(format!(
            "macOS login item command failed: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&result.stdout).into_owned())
}

fn agents(home: &Path) -> PathBuf {
    home.join("Library").join("LaunchAgents")
}

fn item(home: &Path) -> PathBuf {
    agents(home).join(format!("{LABEL}.plist"))
}

fn headless(home: &Path) -> bool {
    // Even a disabled headless entry keeps migration visible until caller-owned
    // uninstall succeeds. This backend registers the app first, never removes this file.
    agents(home).join(format!("{HEADLESS}.plist")).exists()
}

fn bundle(app: &Path) -> Result<PathBuf, String> {
    let executable = app
        .canonicalize()
        .map_err(|e| format!("Cannot resolve the application executable: {e}"))?;
    if !executable.is_file() {
        return Err("The application executable is not a file.".into());
    }
    let macos = executable
        .parent()
        .ok_or("Missing application directory.")?;
    let contents = macos.parent().ok_or("Missing application contents.")?;
    let root = contents.parent().ok_or("Missing application bundle.")?;
    if macos.file_name().is_none_or(|s| s != "MacOS")
        || contents.file_name().is_none_or(|s| s != "Contents")
        || root.extension().is_none_or(|s| s != "app")
        || !contents.join("Info.plist").is_file()
    {
        return Err(
            "Start at login requires an installed .app bundle, not a development executable."
                .into(),
        );
    }
    Ok(root.to_path_buf())
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn plist(app: &Path) -> Result<String, String> {
    let root = bundle(app)?;
    let name = root
        .to_str()
        .ok_or("The application path is not valid UTF-8.")?;
    if name.chars().any(char::is_control) {
        return Err("The application path contains control characters.".into());
    }
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\"><dict>\n\
<key>Label</key><string>{LABEL}</string>\n\
<key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-gj</string><string>{}</string><string>--args</string><string>--background</string></array>\n\
<key>RunAtLoad</key><true/>\n\
</dict></plist>\n",
        xml(name)
    ))
}

fn disabled(text: &str) -> bool {
    text.lines().any(|line| {
        let Some((key, value)) = line.trim().split_once("=>") else {
            return false;
        };
        key.trim() == format!("\"{LABEL}\"")
            && matches!(value.trim().trim_end_matches(','), "true" | "disabled")
    })
}

fn state_at(home: &Path, app: &Path, run: &Run) -> Result<LoginState, String> {
    if headless(home) {
        return Ok(LoginState::Headless);
    }
    app_state_at(home, app, run)
}

// Enable must verify its own registration while the caller's headless entry still
// exists. Public state retains Headless precedence so a failed uninstall can retry.
fn app_state_at(home: &Path, app: &Path, run: &Run) -> Result<LoginState, String> {
    let expected = plist(app)?;
    let actual = match fs::read_to_string(item(home)) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(LoginState::Off),
        Err(error) => return Err(format!("Cannot read the app login item: {error}")),
    };
    if actual != expected {
        return Ok(LoginState::Off);
    }
    let text = run(&["print-disabled", &domain()])?;
    Ok(if disabled(&text) {
        LoginState::Off
    } else {
        LoginState::App
    })
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing login item directory.")?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Cannot create the login item directory: {e}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let tmp = parent.join(format!(".{LABEL}.{}.{}.tmp", std::process::id(), nonce));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o644)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        file.write_all(content).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result.map_err(|e| format!("Cannot save the app login item: {e}"))
}

fn enable_at(home: &Path, app: &Path, run: &Run) -> Result<(), String> {
    let content = plist(app)?;
    let path = item(home);
    let previous = match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Cannot read the prior app login item: {error}")),
    };
    // Snapshot the native state even when there is no (or a different) plist.
    // A failed enable command can still have changed launchd's disabled override.
    let was_disabled = disabled(&run(&["print-disabled", &domain()])?);
    write_atomic(&path, content.as_bytes())?;
    let registration = format!("{}/{LABEL}", domain());
    let result = (|| {
        // Clear a prior disable without bootstrapping a second app beside the current one.
        // RunAtLoad starts it on the next login; the current app already hosts the daemon.
        run(&["enable", &registration])?;
        if app_state_at(home, app, run)? != LoginState::App {
            return Err("The app login registration could not be verified.".into());
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut rollback_errors = Vec::new();
        let restored = match previous {
            Some(bytes) => write_atomic(&path, &bytes),
            None => match fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("Cannot remove the new app login item: {e}")),
            },
        };
        if let Err(e) = restored {
            rollback_errors.push(e);
        }
        // Try both restoration steps independently and report every failure.
        let command = if was_disabled { "disable" } else { "enable" };
        if let Err(e) = run(&[command, &registration]) {
            rollback_errors.push(format!("Cannot restore the native login state: {e}"));
        }
        match run(&["print-disabled", &domain()]) {
            Ok(text) if disabled(&text) == was_disabled => {}
            Ok(_) => rollback_errors
                .push("The restored native login state could not be verified.".into()),
            Err(e) => rollback_errors.push(format!(
                "Cannot verify the restored native login state: {e}"
            )),
        }
        return Err(if rollback_errors.is_empty() {
            error
        } else {
            format!("{error}; rollback failed: {}", rollback_errors.join("; "))
        });
    }
    Ok(())
}

fn disable_at(home: &Path, run: &Run) -> Result<(), String> {
    // Disable scheduling, not the application. bootout would risk terminating the
    // application that is answering this setting; open is a one-shot launch job.
    run(&["disable", &format!("{}/{LABEL}", domain())])?;
    match fs::remove_file(item(home)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot remove the app login item: {error}")),
    }
}

pub fn state(app: &Path) -> Result<LoginState, String> {
    state_at(&crate::runtime::home()?, app, &launchctl)
}

pub fn enable(app: &Path) -> Result<(), String> {
    enable_at(&crate::runtime::home()?, app, &launchctl)
}

pub fn disable() -> Result<(), String> {
    disable_at(&crate::runtime::home()?, &launchctl)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        home: PathBuf,
        app: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let home = std::env::temp_dir().join(format!(
                "mr-login-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            let app = home
                .join("Applications")
                .join("Example & <Menu>.app")
                .join("Contents")
                .join("MacOS")
                .join("Example");
            fs::create_dir_all(app.parent().unwrap()).unwrap();
            fs::write(&app, "fixture").unwrap();
            fs::write(
                app.parent().unwrap().parent().unwrap().join("Info.plist"),
                "fixture",
            )
            .unwrap();
            Self { home, app }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.home);
        }
    }

    #[test]
    fn plist_is_native_valid_hidden_and_has_no_daemon_or_environment() {
        let f = Fixture::new();
        let text = plist(&f.app).unwrap();
        let p = f.home.join("test.plist");
        fs::write(&p, &text).unwrap();
        assert!(Command::new("/usr/bin/plutil")
            .args(["-lint", p.to_str().unwrap()])
            .status()
            .unwrap()
            .success());
        assert!(text.contains("/usr/bin/open"));
        assert!(text.contains("-gj"));
        assert!(text.contains("--background"));
        let extracted = Command::new("/usr/bin/plutil")
            .args([
                "-extract",
                "ProgramArguments",
                "json",
                "-o",
                "-",
                p.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(extracted.status.success());
        let args: Vec<String> = serde_json::from_slice(&extracted.stdout).unwrap();
        assert_eq!(
            args,
            vec![
                "/usr/bin/open".to_string(),
                "-gj".to_string(),
                bundle(&f.app).unwrap().to_str().unwrap().to_string(),
                "--args".to_string(),
                "--background".to_string()
            ]
        );
        assert!(text.contains("&amp; &lt;Menu&gt;.app"));
        assert!(!text.contains("EnvironmentVariables"));
        assert!(!text.contains("daemon"));
    }
    #[test]
    fn refuses_a_development_binary_and_headless_state_has_precedence() {
        let f = Fixture::new();
        assert!(plist(&f.home.join("missing")).is_err());
        let development = f.home.join("development");
        fs::write(&development, "fixture").unwrap();
        assert!(enable_at(&f.home, &development, &|_| panic!("invalid bundle")).is_err());
        fs::create_dir_all(agents(&f.home)).unwrap();
        fs::write(
            agents(&f.home).join(format!("{HEADLESS}.plist")),
            "headless",
        )
        .unwrap();
        assert_eq!(
            state_at(&f.home, &f.app, &|_| panic!("no query needed")).unwrap(),
            LoginState::Headless
        );
        assert!(!item(&f.home).exists());
    }

    #[test]
    fn migration_verifies_app_before_caller_uninstalls_headless() {
        let f = Fixture::new();
        fs::create_dir_all(agents(&f.home)).unwrap();
        let headless_path = agents(&f.home).join(format!("{HEADLESS}.plist"));
        fs::write(&headless_path, "headless registration").unwrap();
        let calls = RefCell::new(Vec::new());
        let run = |args: &[&str]| {
            calls.borrow_mut().push(args[0].to_string());
            assert_eq!(
                fs::read_to_string(&headless_path).unwrap(),
                "headless registration"
            );
            match args[0] {
                "print-disabled" => {
                    assert_eq!(args, ["print-disabled", &domain()]);
                    // Even a disabled headless entry still needs caller-owned removal.
                    Ok(format!("\"{HEADLESS}\" => true\n\"{LABEL}\" => false"))
                }
                "enable" => {
                    assert_eq!(args, ["enable", &format!("{}/{LABEL}", domain())]);
                    Ok(String::new())
                }
                _ => panic!("unexpected native operation"),
            }
        };
        assert_eq!(
            state_at(&f.home, &f.app, &run).unwrap(),
            LoginState::Headless
        );
        // Mirror toggle_login's enable().and_then(daemon uninstall) contract.
        enable_at(&f.home, &f.app, &run)
            .and_then(|()| {
                assert_eq!(fs::read_to_string(item(&f.home)).unwrap(), plist(&f.app)?);
                assert_eq!(
                    state_at(&f.home, &f.app, &|_| panic!("headless takes precedence"))?,
                    LoginState::Headless
                );
                calls.borrow_mut().push("daemon uninstall".into());
                fs::remove_file(&headless_path).map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(
            *calls.borrow(),
            [
                "print-disabled",
                "enable",
                "print-disabled",
                "daemon uninstall"
            ]
        );
        assert!(!headless_path.exists());
        assert_eq!(
            state_at(&f.home, &f.app, &|_| Ok(String::new())).unwrap(),
            LoginState::App
        );
    }

    #[test]
    fn failed_caller_uninstall_keeps_headless_state_and_allows_migration_retry() {
        let f = Fixture::new();
        fs::create_dir_all(agents(&f.home)).unwrap();
        let headless_path = agents(&f.home).join(format!("{HEADLESS}.plist"));
        fs::write(&headless_path, "headless registration").unwrap();
        let calls = RefCell::new(Vec::new());
        let run = |args: &[&str]| {
            calls.borrow_mut().push(args[0].to_string());
            match args[0] {
                "print-disabled" => assert_eq!(args, ["print-disabled", &domain()]),
                "enable" => assert_eq!(args, ["enable", &format!("{}/{LABEL}", domain())]),
                _ => panic!("unexpected native operation"),
            }
            Ok(String::new())
        };
        let error = enable_at(&f.home, &f.app, &run)
            .and_then(|()| {
                calls.borrow_mut().push("daemon uninstall".into());
                Err::<(), String>("uninstall failed".into())
            })
            .unwrap_err();
        assert_eq!(error, "uninstall failed");
        let registered = fs::read(item(&f.home)).unwrap();
        assert_eq!(registered, plist(&f.app).unwrap().as_bytes());
        assert_eq!(
            fs::read_to_string(&headless_path).unwrap(),
            "headless registration"
        );
        assert_eq!(
            state_at(&f.home, &f.app, &|_| panic!(
                "retry must be offered without querying the app"
            ))
            .unwrap(),
            LoginState::Headless
        );
        enable_at(&f.home, &f.app, &run)
            .and_then(|()| {
                assert_eq!(
                    fs::read_to_string(&headless_path).unwrap(),
                    "headless registration"
                );
                calls.borrow_mut().push("daemon uninstall".into());
                fs::remove_file(&headless_path).map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(fs::read(item(&f.home)).unwrap(), registered);
        assert_eq!(
            *calls.borrow(),
            [
                "print-disabled",
                "enable",
                "print-disabled",
                "daemon uninstall",
                "print-disabled",
                "enable",
                "print-disabled",
                "daemon uninstall"
            ]
        );
        assert_eq!(
            state_at(&f.home, &f.app, &|_| Ok(String::new())).unwrap(),
            LoginState::App
        );
    }
    #[test]
    fn enable_is_idempotent_and_disable_never_boots_out_the_app() {
        let f = Fixture::new();
        let calls = RefCell::new(Vec::new());
        let run = |args: &[&str]| {
            calls.borrow_mut().push(args.join(" "));
            Ok(String::new())
        };
        enable_at(&f.home, &f.app, &run).unwrap();
        enable_at(&f.home, &f.app, &run).unwrap();
        assert_eq!(state_at(&f.home, &f.app, &run).unwrap(), LoginState::App);
        disable_at(&f.home, &run).unwrap();
        disable_at(&f.home, &run).unwrap();
        assert!(!item(&f.home).exists());
        assert!(calls
            .borrow()
            .iter()
            .all(|c| !c.contains("bootstrap") && !c.contains("bootout")));
    }
    #[test]
    fn disabled_or_different_app_is_not_reported_active() {
        let f = Fixture::new();
        fs::create_dir_all(agents(&f.home)).unwrap();
        fs::write(item(&f.home), plist(&f.app).unwrap()).unwrap();
        assert_eq!(
            state_at(&f.home, &f.app, &|_| Ok(format!("\"{LABEL}\" => true"))).unwrap(),
            LoginState::Off
        );
        fs::write(item(&f.home), "wrong executable").unwrap();
        assert_eq!(
            state_at(&f.home, &f.app, &|_| panic!("not exact")).unwrap(),
            LoginState::Off
        );
    }
    #[test]
    fn failed_enable_restores_prior_registration_and_query_errors_stay_errors() {
        let f = Fixture::new();
        fs::create_dir_all(agents(&f.home)).unwrap();
        fs::write(item(&f.home), "previous").unwrap();
        let calls = RefCell::new(Vec::new());
        let run = |args: &[&str]| {
            calls.borrow_mut().push(args[0].to_string());
            if args[0] == "enable" && calls.borrow().len() == 2 {
                Err("native failure".into())
            } else {
                Ok(String::new())
            }
        };
        assert_eq!(
            enable_at(&f.home, &f.app, &run).unwrap_err(),
            "native failure"
        );
        assert_eq!(fs::read_to_string(item(&f.home)).unwrap(), "previous");
        assert_eq!(
            *calls.borrow(),
            ["print-disabled", "enable", "enable", "print-disabled"]
        );
        fs::write(item(&f.home), plist(&f.app).unwrap()).unwrap();
        assert!(state_at(&f.home, &f.app, &|_| Err("unavailable".into())).is_err());
    }

    #[test]
    fn prior_read_error_is_not_absence_and_prevents_native_mutation() {
        let f = Fixture::new();
        // Reading a directory is a deterministic non-NotFound I/O error, even as root.
        fs::create_dir_all(item(&f.home)).unwrap();
        let marker = item(&f.home).join("untouched");
        fs::write(&marker, "original").unwrap();
        let error = enable_at(&f.home, &f.app, &|_| {
            panic!("read failure must precede any native command")
        })
        .unwrap_err();
        assert!(error.contains("Cannot read the prior app login item"));
        assert_eq!(fs::read_to_string(marker).unwrap(), "original");
    }

    #[test]
    fn snapshot_query_failure_preserves_registration_before_write() {
        let f = Fixture::new();
        fs::create_dir_all(agents(&f.home)).unwrap();
        fs::write(item(&f.home), "previous").unwrap();
        let error = enable_at(&f.home, &f.app, &|args| {
            assert_eq!(args[0], "print-disabled");
            Err("snapshot unavailable".into())
        })
        .unwrap_err();
        assert_eq!(error, "snapshot unavailable");
        assert_eq!(fs::read_to_string(item(&f.home)).unwrap(), "previous");
    }

    // Every native command is injected. No test changes this user's launchd domain.
    fn assert_post_write_rollback(failure: &str, has_headless: bool) {
        for was_disabled in [false, true] {
            for had_registration in [false, true] {
                let f = Fixture::new();
                let previous = b"previous non-UTF8 registration\xff";
                let headless_path = agents(&f.home).join(format!("{HEADLESS}.plist"));
                if has_headless {
                    fs::create_dir_all(agents(&f.home)).unwrap();
                    fs::write(&headless_path, b"headless registration\xff").unwrap();
                }
                if had_registration {
                    fs::create_dir_all(agents(&f.home)).unwrap();
                    fs::write(item(&f.home), previous).unwrap();
                }
                let native_disabled = std::cell::Cell::new(was_disabled);
                let queries = std::cell::Cell::new(0);
                let enables = std::cell::Cell::new(0);
                let run = |args: &[&str]| match args[0] {
                    "print-disabled" => {
                        queries.set(queries.get() + 1);
                        if queries.get() == 2 && failure == "query" {
                            return Err("verification query failed".into());
                        }
                        let is_disabled =
                            native_disabled.get() || (queries.get() == 2 && failure == "negative");
                        Ok(format!("\"{LABEL}\" => {is_disabled}"))
                    }
                    "enable" => {
                        enables.set(enables.get() + 1);
                        native_disabled.set(false);
                        if enables.get() == 1 && failure == "enable" {
                            return Err("enable failed after side effect".into());
                        }
                        Ok(String::new())
                    }
                    "disable" => {
                        native_disabled.set(true);
                        Ok(String::new())
                    }
                    _ => panic!("unexpected native operation"),
                };
                let error = enable_at(&f.home, &f.app, &run)
                    .inspect(|()| panic!("failed enable must never call daemon uninstall"))
                    .unwrap_err();
                assert!(!error.contains("rollback failed"), "{error}");
                match failure {
                    "query" => assert!(error.contains("verification query failed")),
                    "negative" => assert!(error.contains("could not be verified")),
                    "enable" => assert!(error.contains("enable failed after side effect")),
                    _ => panic!("unexpected failure case"),
                }
                if had_registration {
                    assert_eq!(fs::read(item(&f.home)).unwrap(), previous);
                } else {
                    assert!(!item(&f.home).exists());
                }
                assert_eq!(native_disabled.get(), was_disabled);
                if has_headless {
                    assert_eq!(
                        fs::read(&headless_path).unwrap(),
                        b"headless registration\xff"
                    );
                    assert_eq!(
                        state_at(&f.home, &f.app, &|_| panic!("headless takes precedence"))
                            .unwrap(),
                        LoginState::Headless
                    );
                }
                assert!(fs::read_dir(agents(&f.home)).unwrap().all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")));
            }
        }
    }

    #[test]
    fn enable_error_with_native_side_effect_restores_both_snapshots() {
        assert_post_write_rollback("enable", false);
    }

    #[test]
    fn post_enable_query_failure_restores_both_snapshots() {
        assert_post_write_rollback("query", false);
    }

    #[test]
    fn post_enable_negative_verification_restores_both_snapshots() {
        assert_post_write_rollback("negative", false);
    }

    #[test]
    fn failed_migration_enable_rolls_back_without_uninstalling_headless() {
        for failure in ["enable", "query", "negative"] {
            assert_post_write_rollback(failure, true);
        }
    }

    #[test]
    fn rollback_reports_filesystem_native_and_query_errors_independently() {
        let f = Fixture::new();
        fs::create_dir_all(agents(&f.home)).unwrap();
        fs::write(item(&f.home), "previous").unwrap();
        let calls = RefCell::new(Vec::new());
        let run = |args: &[&str]| {
            calls.borrow_mut().push(args[0].to_string());
            match calls.borrow().len() {
                1 => Ok(format!("\"{LABEL}\" => true")),
                2 => {
                    assert_eq!(args[0], "enable");
                    fs::remove_file(item(&f.home)).unwrap();
                    fs::create_dir(item(&f.home)).unwrap();
                    Err("enable failed".into())
                }
                3 => {
                    assert_eq!(args[0], "disable");
                    Err("native rollback failed".into())
                }
                4 => Err("rollback query failed".into()),
                _ => panic!("unexpected native operation"),
            }
        };
        let error = enable_at(&f.home, &f.app, &run).unwrap_err();
        assert!(error.contains("enable failed"));
        assert!(error.contains("rollback failed"));
        assert!(error.contains("Cannot save the app login item"));
        assert!(error.contains("native rollback failed"));
        assert!(error.contains("rollback query failed"));
        assert_eq!(
            *calls.borrow(),
            ["print-disabled", "enable", "disable", "print-disabled"]
        );
    }

    #[test]
    fn rollback_negative_native_verification_is_reported() {
        let f = Fixture::new();
        let calls = std::cell::Cell::new(0);
        let run = |_: &[&str]| {
            calls.set(calls.get() + 1);
            match calls.get() {
                1 => Ok(format!("\"{LABEL}\" => true")),
                2 => Err("enable failure".into()),
                _ => Ok(String::new()),
            }
        };
        let error = enable_at(&f.home, &f.app, &run).unwrap_err();
        assert!(error.contains("restored native login state could not be verified"));
        assert!(!item(&f.home).exists());
    }
}
