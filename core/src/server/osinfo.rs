//! The handful of `node:os` / `node:fs` facts the diagnostics reads report,
//! spelled the way Node spells them.
//!
//! Each helper here has a Node counterpart whose OUTPUT FORMAT is part of
//! the wire contract — `process.arch` says `arm64` where Rust says
//! `aarch64`, `fs.accessSync` throws `EACCES: permission denied, access
//! '/p'` where `std::io::Error` says `Permission denied (os error 13)` —
//! so the mapping lives here, with the Node spelling as the source of truth.
//! Unix only where a syscall is involved; the non-Unix arms return the
//! honest "don't know" (zeros, `None`) rather than a guess.

use std::path::Path;

/// `process.arch`. Node's names for the targets Rust can be built for.
pub fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "loongarch64" => "loong64",
        "powerpc64" => "ppc64",
        other => other, // arm, mips, riscv64, s390x — identical spellings
    }
}

/// `${os.type()} ${os.release()}` — `uname`'s sysname and release, e.g.
/// `Darwin 25.6.0` or `Linux 6.8.0-45-generic`.
#[cfg(unix)]
pub fn platform_string() -> String {
    let mut uts: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut uts) } != 0 {
        return std::env::consts::OS.to_string();
    }
    let field = |raw: &[libc::c_char]| -> String {
        let bytes: Vec<u8> = raw
            .iter()
            .take_while(|c| **c != 0)
            .map(|c| *c as u8)
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    };
    format!("{} {}", field(&uts.sysname), field(&uts.release))
}

#[cfg(not(unix))]
pub fn platform_string() -> String {
    std::env::consts::OS.to_string()
}

/// `fs.statfsSync(path)` reduced to `(bavail * bsize, blocks * bsize)` —
/// the free and total bytes `lib/disk-usage.ts` derives. `None` where the
/// call fails (Node then reports zeros).
#[cfg(unix)]
pub fn volume_bytes(path: &Path) -> Option<(u64, u64)> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    let bsize = st.f_bsize as u64;
    Some((st.f_bavail as u64 * bsize, st.f_blocks as u64 * bsize))
}

#[cfg(not(unix))]
pub fn volume_bytes(_path: &Path) -> Option<(u64, u64)> {
    None
}

/// `fs.accessSync(path, R_OK | W_OK)`: `Ok` when readable and writable,
/// otherwise the message Node's error would carry — `EACCES: permission
/// denied, access '/p'`. The errno names and phrases are libuv's for the
/// codes a data directory can realistically produce; anything else falls
/// back to the numeric code with std's description.
#[cfg(unix)]
pub fn access_read_write(path: &Path) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let display = path.display();
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else {
        return Err(format!("EINVAL: invalid argument, access '{display}'"));
    };
    if unsafe { libc::access(c.as_ptr(), libc::R_OK | libc::W_OK) } == 0 {
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    let (code, phrase) = match err.raw_os_error() {
        Some(libc::EACCES) => ("EACCES", "permission denied".to_string()),
        Some(libc::ENOENT) => ("ENOENT", "no such file or directory".to_string()),
        Some(libc::EROFS) => ("EROFS", "read-only file system".to_string()),
        Some(libc::EPERM) => ("EPERM", "operation not permitted".to_string()),
        Some(libc::ENOTDIR) => ("ENOTDIR", "not a directory".to_string()),
        Some(libc::ELOOP) => ("ELOOP", "too many symbolic links encountered".to_string()),
        Some(libc::ENAMETOOLONG) => ("ENAMETOOLONG", "name too long".to_string()),
        Some(n) => {
            return Err(format!(
                "E{n}: {}, access '{display}'",
                err.to_string().to_lowercase()
            ))
        }
        None => {
            return Err(format!(
                "EUNKNOWN: {}, access '{display}'",
                err.to_string().to_lowercase()
            ))
        }
    };
    Err(format!("{code}: {phrase}, access '{display}'"))
}

#[cfg(not(unix))]
pub fn access_read_write(path: &Path) -> Result<(), String> {
    match std::fs::metadata(path) {
        Ok(m) if !m.permissions().readonly() => Ok(()),
        Ok(_) => Err(format!(
            "EACCES: permission denied, access '{}'",
            path.display()
        )),
        Err(e) => Err(format!(
            "ENOENT: {}, access '{}'",
            e.to_string().to_lowercase(),
            path.display()
        )),
    }
}

/// `os.homedir()`: `$HOME` when set, else the account's directory.
pub fn home_dir() -> Option<String> {
    if let Ok(h) = std::env::var("HOME") {
        if !h.is_empty() {
            return Some(h);
        }
    }
    #[cfg(unix)]
    {
        let pw = unsafe { libc::getpwuid(libc::getuid()) };
        if !pw.is_null() {
            let dir = unsafe { (*pw).pw_dir };
            if !dir.is_null() {
                let s = unsafe { std::ffi::CStr::from_ptr(dir) };
                return Some(s.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// `fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv")`.
pub fn likely_container() -> bool {
    Path::new("/.dockerenv").exists() || Path::new("/run/.containerenv").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arch_is_spelled_the_node_way() {
        // Whatever this test host is, the answer must be one of Node's names.
        let names = [
            "arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc64", "riscv64", "s390x", "x64",
        ];
        assert!(names.contains(&node_arch()), "{}", node_arch());
        assert_ne!(node_arch(), "aarch64");
        assert_ne!(node_arch(), "x86_64");
    }

    #[test]
    fn platform_is_type_space_release() {
        let p = platform_string();
        let mut parts = p.splitn(2, ' ');
        let sysname = parts.next().unwrap_or("");
        assert!(
            ["Darwin", "Linux", "FreeBSD", "windows"].contains(&sysname) || !sysname.is_empty(),
            "{p}"
        );
        #[cfg(unix)]
        assert!(parts.next().map(|r| !r.is_empty()).unwrap_or(false), "{p}");
    }

    #[test]
    fn access_reports_the_libuv_phrase_for_a_missing_path() {
        let missing = std::env::temp_dir().join("pt-core-definitely-missing-dir/x");
        let err = access_read_write(&missing).unwrap_err();
        assert!(
            err.starts_with("ENOENT: no such file or directory, access '"),
            "{err}"
        );
        assert!(err.ends_with("'"), "{err}");
        assert!(access_read_write(&std::env::temp_dir()).is_ok());
    }

    #[test]
    fn volume_bytes_are_positive_on_a_real_directory() {
        if let Some((free, total)) = volume_bytes(&std::env::temp_dir()) {
            assert!(total > 0);
            assert!(free <= total);
        }
    }
}
