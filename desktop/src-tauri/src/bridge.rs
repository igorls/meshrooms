//! Locates, installs and drives the agent bridge: a Bun and the single-file `meshrooms.js` bundle. The app never runs
//! the daemon itself: it asks the bridge's own CLI (`daemon start|stop|status|uninstall`, `bindings --json`), exactly
//! as an operator would, and the daemon's instance lock stays the one owner.
//!
//! The bundled bridge is a directory with `bun` (`bun.exe` on Windows), `meshrooms.js` and a `manifest.json` whose
//! `version` is the bridge's version (packages/meshrooms, not this app's) and whose `files` map each file to its
//! sha256. It is installed into `~/.meshrooms/app/bridge/<version>-<12 hex of the manifest's sha256>/` with the same
//! verified, all-or-nothing copy as the runtime (`runtime::install`), so a new build never replaces a folder a running
//! daemon was started from. Every time the app resolves it, the installed folder is checked against the bundled
//! manifest, file by file; a folder that doesn't match is moved aside (never deleted) and installed again.

use crate::runtime::{home, install, sha256, BUN};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const SCRIPT: &str = "meshrooms.js";

pub struct Bridge {
    pub bun: PathBuf,
    pub script: PathBuf,
}

fn complete(dir: &Path) -> Option<Bridge> {
    let bridge = Bridge { bun: dir.join(BUN), script: dir.join(SCRIPT) };
    (bridge.bun.is_file() && bridge.script.is_file()).then_some(bridge)
}

/// A bridge version names a directory, so only plain semver characters are accepted.
fn version_of(manifest: &Value) -> Result<String, String> {
    let version = manifest["version"].as_str().unwrap_or_default();
    let plain = !version.is_empty()
        && version.len() <= 64
        && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        && version.chars().next().is_some_and(|c| c.is_ascii_digit())
        && !version.contains("..");
    plain.then(|| version.to_string()).ok_or_else(|| "The bundled bridge manifest has no valid version.".into())
}

/// Development builds: `MESHROOMS_BRIDGE_HOME` (a directory holding bun and meshrooms.js), then this checkout. Release
/// builds never take the bridge's location from the environment. Then the bundled bridge, installed and verified under
/// `~/.meshrooms/app/bridge/`.
pub fn resolve(bundled: Option<PathBuf>) -> Result<Bridge, String> {
    #[cfg(debug_assertions)]
    {
        if let Some(dir) = env::var_os("MESHROOMS_BRIDGE_HOME").map(PathBuf::from) {
            return complete(&dir).ok_or_else(|| format!("MESHROOMS_BRIDGE_HOME does not contain bun and {SCRIPT}: {}", dir.display()));
        }
        if let Some(bridge) = checkout() {
            return bridge;
        }
    }
    let source = bundled
        .filter(|path| path.join("manifest.json").is_file())
        .ok_or("No Meshrooms bridge is installed and this build does not include one.")?;
    installed(&source, &home()?.join(".meshrooms").join("app").join("bridge"))
}

/// The bundled bridge in `root`, verified against the bundled manifest, and installed (again) when it doesn't match.
fn installed(source: &Path, root: &Path) -> Result<Bridge, String> {
    let text = fs::read_to_string(source.join("manifest.json")).map_err(|error| format!("Cannot read the bundled bridge manifest: {error}"))?;
    let manifest: Value = serde_json::from_str(&text).map_err(|error| format!("The bundled bridge manifest is invalid: {error}"))?;
    let files = manifest["files"].as_object().filter(|files| !files.is_empty()).ok_or("The bundled bridge manifest lists no files.")?;
    let digest: String = Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
    let dir = root.join(format!("{}-{}", version_of(&manifest)?, &digest[..12]));
    if matches(&dir, &text, files) {
        return complete(&dir).ok_or_else(|| "The installed bridge is incomplete.".into());
    }
    if fs::symlink_metadata(&dir).is_ok() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or_default();
        let name = dir.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        let aside = root.join(format!(".{name}.replaced-{nanos}"));
        fs::rename(&dir, &aside).map_err(|error| format!("Cannot move the damaged bridge at {} aside: {error}", dir.display()))?;
    }
    install(source, &dir)?;
    if !matches(&dir, &text, files) {
        return Err(format!("The bridge installed at {} does not match its manifest.", dir.display()));
    }
    complete(&dir).ok_or_else(|| "The installed bridge is incomplete.".into())
}

/// The folder holds exactly this manifest and every file it lists, each with its hash.
fn matches(dir: &Path, text: &str, files: &Map<String, Value>) -> bool {
    fs::read_to_string(dir.join("manifest.json")).is_ok_and(|installed| installed == text)
        && files.iter().all(|(name, hash)| hash.as_str().is_some_and(|hash| sha256(&dir.join(name)).is_ok_and(|actual| actual == hash)))
}

/// Development builds run the checkout's built bundle (`bun run build:bridge`) with the developer's Bun.
#[cfg(debug_assertions)]
fn checkout() -> Option<Result<Bridge, String>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").canonicalize().ok()?;
    let package = root.join("packages").join("meshrooms");
    if !package.join("package.json").is_file() {
        return None;
    }
    let script = package.join("bin").join(SCRIPT);
    if !script.is_file() {
        return Some(Err("Run `bun run build:bridge` in the checkout before starting the development app.".into()));
    }
    let search = env::var_os("PATH").map(|paths| env::split_paths(&paths).collect::<Vec<_>>()).unwrap_or_default();
    let bun = search
        .into_iter()
        .chain(home().ok().map(|home| home.join(".bun").join("bin")))
        .map(|dir| dir.join(BUN))
        .find(|path| path.is_file());
    Some(bun.map(|bun| Bridge { bun, script }).ok_or_else(|| "Bun was not found for the development checkout.".into()))
}

/// A console program run without a console window (Windows), so nothing flashes on screen.
pub fn hidden(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Where bridge commands run: the daemon's own folder, private to the user. Bun reads `bunfig.toml` (preloads
/// included) from its working folder, so it never runs from a folder someone else can write.
fn workdir() -> Result<PathBuf, String> {
    let dir = home()?.join(".meshrooms").join("daemon");
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&dir).map_err(|error| format!("Cannot create {}: {error}", dir.display()))?;
    Ok(dir)
}

/// How long one command may take: starting or stopping waits for the daemon (up to 15 s inside the bridge).
fn limit(args: &[&str]) -> Duration {
    match args {
        ["daemon", "start" | "stop" | "install" | "uninstall", ..] => Duration::from_secs(60),
        // Pairing asks in up to 64 rooms, then waits for their runners; creating or joining a room waits for the room
        // service, then for the room's runner.
        ["person", "pair" | "create" | "join", ..] => Duration::from_secs(180),
        // The notification feed is a long poll of up to 30 s.
        ["person", "notifications", ..] => Duration::from_secs(60),
        _ => Duration::from_secs(30),
    }
}

/// `MESHROOMS_*` variables are never passed on, like the bridge's own `bridgeEnv`: an inherited MESHROOMS_DAEMON_DIR or
/// MESHROOMS_AGENT_REGISTRY would make `status` and `stop` look at another daemon than the one `start` manages.
fn bridge_variable(key: &str) -> bool {
    key.to_ascii_uppercase().starts_with("MESHROOMS_")
}

/// Runs one bridge command (`bun --no-env-file meshrooms.js <args>`, from a private folder) and returns the last JSON
/// object it printed. A failure is its last stderr line; a command that outlives its limit is stopped and reported.
pub fn cli(bridge: &Bridge, args: &[&str]) -> Result<Value, String> {
    cli_with_input(bridge, args, None)
}

/// `cli`, with `input` written to the command's stdin: how a secret reaches the bridge, never on its command line,
/// which other programs of this machine can read.
pub fn cli_with_input(bridge: &Bridge, args: &[&str], input: Option<&[u8]>) -> Result<Value, String> {
    let mut command = hidden(&bridge.bun);
    command.arg("--no-env-file").arg(&bridge.script).args(args).current_dir(workdir()?);
    for (key, _) in env::vars_os() {
        if bridge_variable(&key.to_string_lossy()) {
            command.env_remove(&key);
        }
    }
    let mut child = command
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot run the Meshrooms bridge: {error}"))?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        use std::io::Write;
        // Dropped right after, so the command reads to the end of its input.
        let written = stdin.write_all(input);
        drop(stdin);
        if let Err(error) = written {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Cannot hand the Meshrooms bridge its input: {error}"));
        }
    }
    let collect = |pipe: Option<Box<dyn Read + Send>>| {
        let (send, receive) = mpsc::channel();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            let _ = send.send(bytes);
        });
        receive
    };
    let stdout = collect(child.stdout.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let stderr = collect(child.stderr.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let limit = limit(args);
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("`{}` did not finish within {} s, so it was stopped.", args.join(" "), limit.as_secs()));
            }
            Err(error) => return Err(format!("Cannot wait for the Meshrooms bridge: {error}")),
        }
    };
    // The pipes close with the process; a grandchild that kept one open can't hold the caller.
    let read = |receive: mpsc::Receiver<Vec<u8>>| String::from_utf8_lossy(&receive.recv_timeout(Duration::from_secs(5)).unwrap_or_default()).into_owned();
    let (stdout, stderr) = (read(stdout), read(stderr));
    if !status.success() {
        let message = stderr.lines().rev().map(str::trim).find(|line| !line.is_empty()).unwrap_or("The Meshrooms bridge failed.");
        return Err(message.to_string());
    }
    last_json(&stdout).ok_or_else(|| "The Meshrooms bridge returned no result.".into())
}

fn last_json(stdout: &str) -> Option<Value> {
    // An object, or a list (`person rooms` prints one).
    stdout.lines().rev().find_map(|line| serde_json::from_str::<Value>(line.trim()).ok().filter(|value| value.is_object() || value.is_array()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(label: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = env::temp_dir().join(format!("meshrooms-bridge-{label}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn hash(body: &str) -> String {
        Sha256::digest(body.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// A bundled bridge: bun, meshrooms.js and a notice, with its manifest.
    fn bundle(dir: &Path, version: &str, script: &str) {
        // The built UI the daemon serves rides along in ui/, nested like any other listed file.
        let files = [(BUN, "bun"), (SCRIPT, script), ("LICENSE", "license"), ("ui/index.html", "<!doctype html>"), ("ui/assets/index-abc.js", "console.log(1)")];
        fs::create_dir_all(dir).unwrap();
        for (name, body) in files {
            fs::create_dir_all(dir.join(name).parent().unwrap()).unwrap();
            fs::write(dir.join(name), body).unwrap();
        }
        let hashes: Map<String, Value> = files.iter().map(|(name, body)| (name.to_string(), Value::from(hash(body)))).collect();
        fs::write(dir.join("manifest.json"), json!({ "schema": 1, "version": version, "files": hashes }).to_string()).unwrap();
    }

    fn folders(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(root).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn versions_must_be_plain_directory_names() {
        assert_eq!(version_of(&json!({ "version": "0.2.0-beta.5" })).unwrap(), "0.2.0-beta.5");
        for bad in [json!({}), json!({ "version": "" }), json!({ "version": "../x" }), json!({ "version": "1/2" }), json!({ "version": "v1" })] {
            assert!(version_of(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn installs_into_a_folder_keyed_by_version_and_manifest_and_reuses_it() {
        let root = scratch("install");
        let (source, home) = (root.join("bundle"), root.join("bridge"));
        bundle(&source, "0.2.0-beta.5", "bridge one");
        let bridge = installed(&source, &home).unwrap();
        assert_eq!(fs::read_to_string(&bridge.script).unwrap(), "bridge one");
        assert_eq!(fs::read_to_string(bridge.script.parent().unwrap().join("ui").join("assets").join("index-abc.js")).unwrap(), "console.log(1)");
        let names = folders(&home);
        assert_eq!(names.len(), 1);
        assert!(names[0].starts_with("0.2.0-beta.5-") && names[0].len() == "0.2.0-beta.5-".len() + 12, "{names:?}");
        installed(&source, &home).unwrap();
        assert_eq!(folders(&home), names, "a matching install is reused");
        // A new build of the same version gets a folder of its own; the old one, maybe still running, is left alone.
        bundle(&source, "0.2.0-beta.5", "bridge two");
        assert_eq!(fs::read_to_string(installed(&source, &home).unwrap().script).unwrap(), "bridge two");
        assert_eq!(folders(&home).len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_or_changed_file_or_a_stale_manifest_is_installed_again_and_the_old_folder_kept_aside() {
        let root = scratch("repair");
        let (source, home) = (root.join("bundle"), root.join("bridge"));
        bundle(&source, "0.2.0-beta.5", "bridge");
        let dir = installed(&source, &home).unwrap().script.parent().unwrap().to_path_buf();
        type Harm = fn(&Path);
        let damage: [(&str, Harm); 4] = [
            ("missing file", |dir| fs::remove_file(dir.join("LICENSE")).unwrap()),
            ("changed file", |dir| fs::write(dir.join(SCRIPT), "tampered").unwrap()),
            ("changed UI file", |dir| fs::write(dir.join("ui").join("assets").join("index-abc.js"), "tampered").unwrap()),
            ("stale manifest", |dir| fs::write(dir.join("manifest.json"), "{\"files\":{}}").unwrap()),
        ];
        for (round, (label, harm)) in damage.iter().enumerate() {
            harm(&dir);
            let bridge = installed(&source, &home).unwrap_or_else(|error| panic!("{label}: {error}"));
            assert_eq!(fs::read_to_string(&bridge.script).unwrap(), "bridge", "{label}");
            assert!(dir.join("LICENSE").is_file(), "{label}");
            assert_eq!(fs::read_to_string(dir.join("ui").join("assets").join("index-abc.js")).unwrap(), "console.log(1)", "{label}");
            let aside = folders(&home).into_iter().filter(|name| name.contains(".replaced-")).count();
            assert_eq!(aside, round + 1, "{label}: the damaged folder is moved aside, not deleted");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bridge_variables_are_not_passed_on() {
        for key in ["MESHROOMS_DAEMON_DIR", "meshrooms_agent_registry", "Meshrooms_Bin_Dir"] {
            assert!(bridge_variable(key), "{key}");
        }
        for key in ["PATH", "USERPROFILE", "HOME", "XMESHROOMS_X", "MESHROOMS"] {
            assert!(!bridge_variable(key), "{key}");
        }
    }

    #[test]
    fn slow_commands_get_more_time() {
        assert_eq!(limit(&["daemon", "start"]), Duration::from_secs(60));
        assert_eq!(limit(&["daemon", "uninstall"]), Duration::from_secs(60));
        assert_eq!(limit(&["daemon", "status"]), Duration::from_secs(30));
        assert_eq!(limit(&["bindings", "--json"]), Duration::from_secs(30));
        assert_eq!(limit(&["person", "pair", "--origin", "https://rooms.example"]), Duration::from_secs(180));
        assert_eq!(limit(&["person", "join", "https://rooms.example/r/00000000-0000-4000-8000-000000000001"]), Duration::from_secs(180));
        assert_eq!(limit(&["person", "create", "--title", "x"]), Duration::from_secs(180));
        assert_eq!(limit(&["person", "rooms"]), Duration::from_secs(30));
        assert_eq!(limit(&["person", "notifications", "--after", "abcd0123.1", "--wait", "20"]), Duration::from_secs(60));
        assert_eq!(limit(&["person", "open", "--room", "00000000-0000-4000-8000-000000000001"]), Duration::from_secs(30));
    }

    #[test]
    fn the_result_is_the_last_json_object_printed() {
        assert_eq!(last_json("progress\n{\"a\":1}\n{\"running\":true}\n\n"), Some(json!({ "running": true })));
        assert_eq!(last_json("{\"a\":1}\n42\n"), Some(json!({ "a": 1 })));
        assert_eq!(last_json("no json here"), None);
        assert_eq!(last_json("[{\"roomId\":\"r1\"}]\n"), Some(json!([{ "roomId": "r1" }])));
    }
}
