//! Locates, installs and drives the Meshrooms runtime. The shell never owns the daemon:
//! it asks the runtime's own CLI to start or reuse the node, exactly as an agent would.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

pub struct Runtime {
    pub bun: PathBuf,
    pub cli: PathBuf,
}

const BUN: &str = if cfg!(windows) { "bun.exe" } else { "bun" };
const NATIVE: &str = if cfg!(windows) {
    "wormdb_ffi.dll"
} else if cfg!(target_os = "macos") {
    "libwormdb_ffi.dylib"
} else {
    "libwormdb_ffi.so"
};

fn home() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Cannot locate the home directory.".into())
}

/// The layout the skill requires: its own Bun, the CLI, the built UI and the native library.
fn complete(dir: &Path) -> Option<Runtime> {
    let runtime = Runtime { bun: dir.join(BUN), cli: dir.join("server").join("cli.ts") };
    let ready = runtime.bun.is_file()
        && runtime.cli.is_file()
        && dir.join("dist").join("index.html").is_file()
        && dir.join(".local").join("native").join(NATIVE).is_file();
    ready.then_some(runtime)
}

/// `MESHROOMS_HOME`, then (debug builds) this checkout, then `~/.meshrooms/app`, installing
/// the bundled runtime there when nothing exists yet. An existing directory is never replaced.
pub fn resolve(bundled: Option<PathBuf>) -> Result<Runtime, String> {
    if let Some(dir) = env::var_os("MESHROOMS_HOME").map(PathBuf::from) {
        return complete(&dir).ok_or_else(|| format!("MESHROOMS_HOME does not contain a complete runtime: {}", dir.display()));
    }
    #[cfg(debug_assertions)]
    if let Some(runtime) = checkout() {
        return runtime;
    }
    let dir = home()?.join(".meshrooms").join("app");
    if let Some(runtime) = complete(&dir) {
        return Ok(runtime);
    }
    if dir.exists() {
        return Err(format!("An incomplete or incompatible runtime is at {}. It was left untouched.", dir.display()));
    }
    let source = bundled
        .filter(|path| path.join("manifest.json").is_file())
        .ok_or("No Meshrooms runtime is installed and this build does not include one.")?;
    install(&source, &dir)?;
    complete(&dir).ok_or_else(|| "The installed runtime is incomplete.".into())
}

/// Development builds run the repository's sources with the developer's Bun.
#[cfg(debug_assertions)]
fn checkout() -> Option<Result<Runtime, String>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").canonicalize().ok()?;
    let cli = root.join("server").join("cli.ts");
    if !cli.is_file() {
        return None;
    }
    if !root.join("dist").join("index.html").is_file() {
        return Some(Err("Run `bun run build` in the checkout before starting the development shell.".into()));
    }
    let search = env::var_os("PATH").map(|paths| env::split_paths(&paths).collect::<Vec<_>>()).unwrap_or_default();
    let bun = search
        .into_iter()
        .chain(home().ok().map(|home| home.join(".bun").join("bin")))
        .map(|dir| dir.join(BUN))
        .find(|path| path.is_file());
    Some(bun.map(|bun| Runtime { bun, cli }).ok_or_else(|| "Bun was not found for the development checkout.".into()))
}

fn sha256(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    Ok(Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Copies only manifest-listed files into a staging directory, checking each hash before and
/// after the copy, then renames it into place so a partial install is never visible.
fn install(source: &Path, target: &Path) -> Result<(), String> {
    let text = fs::read_to_string(source.join("manifest.json")).map_err(|error| format!("Cannot read the bundled manifest: {error}"))?;
    let manifest: Value = serde_json::from_str(&text).map_err(|error| format!("The bundled manifest is invalid: {error}"))?;
    let files = manifest["files"].as_object().filter(|files| !files.is_empty()).ok_or("The bundled manifest lists no files.")?;
    let parent = target.parent().ok_or("The runtime directory has no parent.")?;
    fs::create_dir_all(parent).map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    let staging = parent.join(format!(".app-install-{}", std::process::id()));
    fs::create_dir(&staging).map_err(|error| format!("Cannot create {}: {error}", staging.display()))?;
    let copied = (|| {
        for (name, expected) in files {
            let expected = expected.as_str().ok_or("The bundled manifest has an invalid hash.")?;
            let relative = Path::new(name);
            if !relative.components().all(|part| matches!(part, Component::Normal(_))) {
                return Err(format!("The bundled manifest lists an unsafe path: {name}"));
            }
            let (from, to) = (source.join(relative), staging.join(relative));
            if sha256(&from)? != expected {
                return Err(format!("The bundled runtime file does not match its manifest: {name}"));
            }
            fs::create_dir_all(to.parent().unwrap_or(&staging)).map_err(|error| error.to_string())?;
            fs::copy(&from, &to).map_err(|error| format!("Cannot copy {name}: {error}"))?;
            if sha256(&to)? != expected {
                return Err(format!("The installed runtime file does not match its manifest: {name}"));
            }
        }
        fs::write(staging.join("manifest.json"), &text).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(staging.join(BUN), fs::Permissions::from_mode(0o755)).map_err(|error| error.to_string())?;
        }
        fs::rename(&staging, target).map_err(|error| format!("Cannot activate the runtime at {}: {error}", target.display()))
    })();
    if copied.is_err() {
        // Only the staging directory this call created; the target was never touched.
        let _ = fs::remove_dir_all(&staging);
    }
    copied
}

/// Runs one CLI command and returns its JSON result. Output may hold a one-time browser
/// ticket, so it is returned to the caller and never logged.
pub fn cli(runtime: &Runtime, args: &[&str]) -> Result<Value, String> {
    let output = Command::new(&runtime.bun)
        .arg("run")
        .arg(&runtime.cli)
        .args(args)
        .current_dir(home()?)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("Cannot run the Meshrooms runtime: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.lines().rev().map(str::trim).find(|line| !line.is_empty()).unwrap_or("The Meshrooms runtime failed.");
        return Err(message.to_string());
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line).ok())
        .ok_or_else(|| "The Meshrooms runtime returned no result.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = env::temp_dir().join(format!("meshrooms-desktop-{label}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn bundle(dir: &Path, files: &[(&str, &str)], listed: &[(&str, &str)]) {
        for (name, body) in files {
            let path = dir.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body).unwrap();
        }
        let hashes: serde_json::Map<String, Value> = listed
            .iter()
            .map(|(name, body)| (name.to_string(), Value::from(Sha256::digest(body.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>())))
            .collect();
        fs::write(dir.join("manifest.json"), serde_json::json!({ "schema": 1, "files": hashes }).to_string()).unwrap();
    }

    #[test]
    fn installs_only_listed_verified_files() {
        let root = scratch("install");
        let (source, target) = (root.join("bundle"), root.join("home").join("app"));
        let files = [(BUN, "bun"), ("server/cli.ts", "cli"), ("dist/index.html", "ui")];
        bundle(&source, &[&files[..], &[("unlisted.txt", "extra")]].concat(), &files);
        install(&source, &target).unwrap();
        assert_eq!(fs::read_to_string(target.join("server/cli.ts")).unwrap(), "cli");
        assert!(target.join("manifest.json").is_file());
        assert!(!target.join("unlisted.txt").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(target.join(BUN)).unwrap().permissions().mode() & 0o777, 0o755);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tampered_or_unsafe_bundles_leave_no_runtime() {
        let root = scratch("reject");
        let (source, target) = (root.join("bundle"), root.join("home").join("app"));
        bundle(&source, &[(BUN, "altered"), ("server/cli.ts", "cli")], &[(BUN, "bun"), ("server/cli.ts", "cli")]);
        assert!(install(&source, &target).unwrap_err().contains("does not match"));
        bundle(&source, &[(BUN, "bun")], &[(BUN, "bun"), ("../escape", "x")]);
        assert!(install(&source, &target).unwrap_err().contains("unsafe path"));
        assert!(!target.exists());
        assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), 0, "staging directories are removed");
        fs::remove_dir_all(root).unwrap();
    }
}
