// Install an update only when it is really newer than the running app.
//
// The updater plugin decides an update is newer from the `version` field of
// latest-v2.json, and that manifest is not signed: the minisign signature
// covers only the archive it points at. So the version it states proves
// nothing about the build it delivers. An older build, validly signed when
// it was released, would pass the signature check under a manifest that
// claims a higher number.
//
// `install_verified_update` replaces the plugin's own download-and-install
// for the page. It downloads through the plugin, so the signature is still
// checked, then reads the version from the signed archive itself (the
// bundle's CFBundleShortVersionString) and installs only if that is
// strictly newer than the running version. After installing it reads the
// version again from the bundle now on disk, which is what a relaunch
// would start, and reports failure unless that is newer too. The page
// (lib/tauri-updater.ts) relaunches only after this succeeds, and the
// capability grants it the plugin's `check` alone, so it cannot install
// through the plugin directly.
//
// Only macOS builds ship. Anywhere else there is no bundle version to read,
// so an install is refused rather than trusted.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{Manager, ResourceId, Webview};
use tauri_plugin_updater::Update;

/// What the page gets back from a successful install.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedInstall {
    /// The version of the bundle now installed.
    pub installed_version: String,
    /// The version of the app that is running (and will be replaced).
    pub running_version: String,
}

/// Download the update the page's `check()` found (its resource id),
/// confirm the signed archive is newer than the running app, install it,
/// and confirm the installed bundle is newer too.
#[tauri::command]
pub async fn install_verified_update(
    webview: Webview,
    rid: ResourceId,
) -> Result<VerifiedInstall, String> {
    let update = webview
        .resources_table()
        .get::<Update>(rid)
        .map_err(|e| e.to_string())?;
    let running = webview.app_handle().package_info().version.clone();

    // Checks the minisign signature before returning the bytes.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    let archived = archive_bundle_version(&bytes)?;
    ensure_newer(&archived, &running)
        .map_err(|why| format!("The downloaded update {why}. It was not installed."))?;

    update.install(&bytes).map_err(|e| e.to_string())?;

    let installed = installed_bundle_version()?;
    ensure_newer(&installed, &running).map_err(|why| {
        format!(
            "The update that was installed {why}, so privacytracker did not restart. \
             Download the current version from the releases page and install it again."
        )
    })?;

    Ok(VerifiedInstall {
        installed_version: installed,
        running_version: running.to_string(),
    })
}

/// Refuse unless `candidate` is a valid version strictly newer than
/// `running`. An unreadable version is refused too. The error completes a
/// sentence that starts with what was checked ("The downloaded update …").
pub(crate) fn ensure_newer(candidate: &str, running: &semver::Version) -> Result<(), String> {
    match semver::Version::parse(candidate) {
        Ok(version) if version > *running => Ok(()),
        Ok(_) => Err(format!(
            "is version {candidate}, which is not newer than the version you are running ({running})"
        )),
        Err(_) => Err(format!("has a version privacytracker can't read ({candidate:?})")),
    }
}

/// CFBundleShortVersionString of the app bundle inside an updater archive
/// (`<name>.app.tar.gz`). The updater unpacks the archive with its first
/// path component removed, so the bundle's Info.plist is the entry at
/// `<name>.app/Contents/Info.plist`. If the archive holds that path more
/// than once, the last copy is the one unpacking leaves on disk, so that is
/// the one read.
pub(crate) fn archive_bundle_version(bytes: &[u8]) -> Result<String, String> {
    let unreadable = |e: std::io::Error| format!("The downloaded update could not be read: {e}");
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let mut info_plist = None;
    for entry in archive.entries().map_err(unreadable)? {
        let mut entry = entry.map_err(unreadable)?;
        let is_info_plist = {
            let path = entry.path().map_err(unreadable)?;
            let rest: PathBuf = path.iter().skip(1).collect();
            rest == Path::new("Contents").join("Info.plist")
        };
        if is_info_plist {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(unreadable)?;
            info_plist = Some(buf);
        }
    }
    let info_plist = info_plist
        .ok_or_else(|| "The downloaded update has no app bundle in it. It was not installed.".to_string())?;
    short_version(&info_plist)
        .ok_or_else(|| "The downloaded update's app bundle has no version. It was not installed.".to_string())
}

/// CFBundleShortVersionString of the bundle this process runs from, read
/// from disk: after an install, the version a relaunch would start.
fn installed_bundle_version() -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("privacytracker could not find its own app bundle: {e}"))?;
    let plist_path = bundle_info_plist(&exe).ok_or_else(|| {
        "privacytracker is not running from an app bundle, so it can't check the installed version.".to_string()
    })?;
    let bytes = std::fs::read(&plist_path)
        .map_err(|e| format!("privacytracker could not read {}: {e}", plist_path.display()))?;
    short_version(&bytes)
        .ok_or_else(|| format!("{} has no version.", plist_path.display()))
}

/// `<bundle>.app/Contents/Info.plist` for an executable at
/// `<bundle>.app/Contents/MacOS/<name>`.
fn bundle_info_plist(exe: &Path) -> Option<PathBuf> {
    let macos_dir = exe.parent()?;
    let contents = macos_dir.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos_dir.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    is_bundle.then(|| contents.join("Info.plist"))
}

/// CFBundleShortVersionString from an Info.plist, XML or binary.
fn short_version(info_plist: &[u8]) -> Option<String> {
    let value = plist::Value::from_reader(std::io::Cursor::new(info_plist)).ok()?;
    value
        .as_dictionary()?
        .get("CFBundleShortVersionString")?
        .as_string()
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn info_plist(version: &str) -> Vec<u8> {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>org.privacykey.privacytracker</string>
  <key>CFBundleShortVersionString</key>
  <string>{version}</string>
  <key>CFBundleVersion</key>
  <string>{version}</string>
</dict>
</plist>
"#
        )
        .into_bytes()
    }

    /// A `.app.tar.gz` shaped like the one tauri-bundler writes.
    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut tar = tar::Builder::new(gz);
        for (path, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, path, *data).expect("append entry");
        }
        let mut gz = tar.into_inner().expect("finish tar");
        gz.flush().expect("flush gzip");
        gz.finish().expect("finish gzip")
    }

    fn v(s: &str) -> semver::Version {
        semver::Version::parse(s).expect("version")
    }

    #[test]
    fn reads_the_version_from_the_bundle_in_the_archive() {
        let plist = info_plist("0.3.1");
        let bytes = archive(&[
            ("privacytracker.app/Contents/MacOS/privacytracker", b"binary"),
            ("privacytracker.app/Contents/Info.plist", &plist),
            // A nested bundle's Info.plist is not the app's.
            (
                "privacytracker.app/Contents/Resources/helper.app/Contents/Info.plist",
                &info_plist("9.9.9"),
            ),
        ]);
        assert_eq!(archive_bundle_version(&bytes).as_deref(), Ok("0.3.1"));
    }

    #[test]
    fn the_last_copy_of_a_repeated_info_plist_wins() {
        let bytes = archive(&[
            ("privacytracker.app/Contents/Info.plist", &info_plist("9.0.0")),
            ("privacytracker.app/Contents/Info.plist", &info_plist("0.1.2")),
        ]);
        assert_eq!(archive_bundle_version(&bytes).as_deref(), Ok("0.1.2"));
    }

    #[test]
    fn an_archive_without_a_bundle_version_is_refused() {
        let no_bundle = archive(&[("privacytracker.app/Contents/MacOS/privacytracker", b"binary")]);
        assert!(archive_bundle_version(&no_bundle).is_err());

        let no_version = archive(&[(
            "privacytracker.app/Contents/Info.plist",
            b"<?xml version=\"1.0\"?><plist version=\"1.0\"><dict></dict></plist>",
        )]);
        assert!(archive_bundle_version(&no_version).is_err());

        assert!(archive_bundle_version(b"not a gzip stream").is_err());
    }

    #[test]
    fn only_a_strictly_newer_version_is_installed() {
        let running = v("0.3.0");
        assert!(ensure_newer("0.3.1", &running).is_ok());
        assert!(ensure_newer("1.0.0", &running).is_ok());

        let same = ensure_newer("0.3.0", &running).unwrap_err();
        assert!(same.contains("not newer") && same.contains("(0.3.0)"), "{same}");
        assert!(ensure_newer("0.1.2", &running).is_err());
        // A pre-release of the running version is older than it.
        assert!(ensure_newer("0.3.0-rc.1", &running).is_err());
        // An unreadable version is refused, never treated as newer.
        assert!(ensure_newer("latest", &running).is_err());
        assert!(ensure_newer("", &running).is_err());
    }

    #[test]
    fn finds_the_info_plist_of_the_running_bundle() {
        assert_eq!(
            bundle_info_plist(Path::new(
                "/Applications/privacytracker.app/Contents/MacOS/privacytracker"
            )),
            Some(PathBuf::from("/Applications/privacytracker.app/Contents/Info.plist")),
        );
        // `cargo run` and tests run a bare binary, with no bundle around it.
        assert_eq!(
            bundle_info_plist(Path::new("/repo/src-tauri/target/debug/privacytracker")),
            None,
        );
    }
}
