//! The verified install shared by everything the app bundles: a directory with a `manifest.json` that maps each file
//! to its sha256 is copied file by file, each hash checked before and after, into a staging directory that is renamed
//! into place, so a partial install is never visible. The bridge (bridge.rs) installs through it.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

pub(crate) const BUN: &str = if cfg!(windows) { "bun.exe" } else { "bun" };

/// The home folder as Bun's `os.homedir()` sees it, so the app and the bridge agree: USERPROFILE first on Windows.
pub(crate) fn home() -> Result<PathBuf, String> {
    let (first, second) = if cfg!(windows) { ("USERPROFILE", "HOME") } else { ("HOME", "USERPROFILE") };
    env::var_os(first)
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os(second))
        .map(PathBuf::from)
        .ok_or_else(|| "Cannot locate the home directory.".into())
}

pub(crate) fn sha256(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    Ok(Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Copies only manifest-listed files into a staging directory, checking each hash before and
/// after the copy, then renames it into place so a partial install is never visible.
pub(crate) fn install(source: &Path, target: &Path) -> Result<(), String> {
    let text = fs::read_to_string(source.join("manifest.json")).map_err(|error| format!("Cannot read the bundled manifest: {error}"))?;
    let manifest: Value = serde_json::from_str(&text).map_err(|error| format!("The bundled manifest is invalid: {error}"))?;
    let files = manifest["files"].as_object().filter(|files| !files.is_empty()).ok_or("The bundled manifest lists no files.")?;
    let parent = target.parent().ok_or("The runtime directory has no parent.")?;
    fs::create_dir_all(parent).map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    // Unique per attempt, so a staging folder an interrupted install left behind never blocks the next one.
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or_default();
    let staging = parent.join(format!(".app-install-{}-{nanos}", std::process::id()));
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
