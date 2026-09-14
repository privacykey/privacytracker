//! Process and host measurements for the runtime envelope — what Node reads
//! from `process.memoryUsage()`, `process.resourceUsage()` and `node:os`,
//! read here from `getrusage`, the per-platform process-info call and
//! `/proc` or Mach.
//!
//! `getrusage(RUSAGE_SELF)` is what libuv's `uv_getrusage` wraps, so the
//! CPU times, page faults and context switches have the same source as
//! Node's. What Node cannot report and this can — virtual size, thread
//! count, open descriptors — comes from `proc_pidinfo` on macOS and `/proc`
//! on Linux; on any other platform those are `null`, never guessed.

use serde::Serialize;
use serde_json::Value;

use crate::jsnum::js_number;

const MB: f64 = 1024.0 * 1024.0;

/// `toMb`: MiB rounded to two decimals, printed as a JavaScript number.
pub fn mb(bytes: u64) -> Value {
    js_number((bytes as f64 / MB * 100.0).round() / 100.0)
}

fn round2(x: f64) -> Value {
    js_number((x * 100.0).round() / 100.0)
}

/// `ProcessMetrics`, key order as in the envelope.
#[derive(Serialize, Clone, Debug)]
pub struct ProcessMetrics {
    pub pid: u32,
    #[serde(rename = "rssMb")]
    pub rss_mb: Value,
    #[serde(rename = "peakRssMb")]
    pub peak_rss_mb: Value,
    #[serde(rename = "virtualMb")]
    pub virtual_mb: Value,
    pub threads: Value,
    #[serde(rename = "openFds")]
    pub open_fds: Value,
    #[serde(rename = "userCpuSeconds")]
    pub user_cpu_seconds: Value,
    #[serde(rename = "systemCpuSeconds")]
    pub system_cpu_seconds: Value,
    #[serde(rename = "minorPageFaults")]
    pub minor_page_faults: i64,
    #[serde(rename = "majorPageFaults")]
    pub major_page_faults: i64,
    #[serde(rename = "voluntaryContextSwitches")]
    pub voluntary_context_switches: i64,
    #[serde(rename = "involuntaryContextSwitches")]
    pub involuntary_context_switches: i64,
}

/// What `proc_pidinfo` / `/proc/self` know that `getrusage` does not.
struct PlatformProcess {
    rss_bytes: Option<u64>,
    virtual_bytes: Option<u64>,
    threads: Option<i64>,
    open_fds: Option<i64>,
}

#[cfg(target_os = "macos")]
fn platform_process() -> PlatformProcess {
    use std::mem::{size_of, zeroed};
    let pid = std::process::id() as libc::c_int;
    let mut info: libc::proc_taskinfo = unsafe { zeroed() };
    let want = size_of::<libc::proc_taskinfo>() as libc::c_int;
    let got = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTASKINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            want,
        )
    };
    let task = if got == want { Some(info) } else { None };
    // PROC_PIDLISTFDS with a null buffer answers with the size the list
    // needs; one `proc_fdinfo` per descriptor.
    let fd_bytes =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    let open_fds = if fd_bytes > 0 {
        Some(fd_bytes as i64 / size_of::<libc::proc_fdinfo>() as i64)
    } else {
        None
    };
    PlatformProcess {
        rss_bytes: task.map(|t| t.pti_resident_size),
        virtual_bytes: task.map(|t| t.pti_virtual_size),
        threads: task.map(|t| t.pti_threadnum as i64),
        open_fds,
    }
}

#[cfg(target_os = "linux")]
fn platform_process() -> PlatformProcess {
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(0) as u64;
    let statm = std::fs::read_to_string("/proc/self/statm").ok();
    let mut fields = statm.as_deref().unwrap_or("").split_whitespace();
    let virtual_pages = fields.next().and_then(|s| s.parse::<u64>().ok());
    let resident_pages = fields.next().and_then(|s| s.parse::<u64>().ok());
    let threads = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("Threads:"))
                .and_then(|v| v.trim().parse::<i64>().ok())
        });
    let open_fds = std::fs::read_dir("/proc/self/fd")
        .ok()
        .map(|d| d.count() as i64);
    PlatformProcess {
        rss_bytes: resident_pages.map(|p| p * page),
        virtual_bytes: virtual_pages.map(|p| p * page),
        threads,
        open_fds,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn platform_process() -> PlatformProcess {
    PlatformProcess {
        rss_bytes: None,
        virtual_bytes: None,
        threads: None,
        open_fds: None,
    }
}

/// `snapshotProcess()`.
pub fn process_metrics() -> ProcessMetrics {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    let ok = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) } == 0;
    let tv = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1_000_000.0;
    // ru_maxrss is bytes on macOS and kilobytes on Linux — libuv normalises
    // to kilobytes and Node divides by 1024.
    #[cfg(target_os = "macos")]
    let max_rss_bytes = ru.ru_maxrss as u64;
    #[cfg(not(target_os = "macos"))]
    let max_rss_bytes = ru.ru_maxrss as u64 * 1024;

    let plat = platform_process();
    let opt = |v: Option<u64>| v.map(mb).unwrap_or(Value::Null);
    let opt_i = |v: Option<i64>| v.map(Value::from).unwrap_or(Value::Null);
    ProcessMetrics {
        pid: std::process::id(),
        // RSS now; fall back to the high-water mark when the platform call
        // fails, which is at least a true upper bound.
        rss_mb: plat.rss_bytes.map(mb).unwrap_or_else(|| {
            if ok {
                mb(max_rss_bytes)
            } else {
                Value::Null
            }
        }),
        peak_rss_mb: if ok { mb(max_rss_bytes) } else { Value::Null },
        virtual_mb: opt(plat.virtual_bytes),
        threads: opt_i(plat.threads),
        open_fds: opt_i(plat.open_fds),
        user_cpu_seconds: if ok {
            round2(tv(ru.ru_utime))
        } else {
            Value::Null
        },
        system_cpu_seconds: if ok {
            round2(tv(ru.ru_stime))
        } else {
            Value::Null
        },
        minor_page_faults: ru.ru_minflt as i64,
        major_page_faults: ru.ru_majflt as i64,
        voluntary_context_switches: ru.ru_nvcsw as i64,
        involuntary_context_switches: ru.ru_nivcsw as i64,
    }
}

/// `os.totalmem()` / `os.freemem()` / `os.cpus().length`, for the desktop
/// report's `host` block. Free memory is what libuv reports: `free_count`
/// pages on macOS, `MemAvailable` on Linux.
pub struct HostMemory {
    pub total_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
}

pub fn host_memory() -> HostMemory {
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(0) as u64;
    let phys = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
    let total_bytes = if phys > 0 {
        Some(phys as u64 * page)
    } else {
        None
    };
    HostMemory {
        total_bytes,
        free_bytes: free_memory_bytes(page),
    }
}

// `mach_host_self` is deprecated in libc in favour of the `mach2` crate —
// a dependency this crate does not otherwise need for one call that libc
// still exports and libuv makes the same way.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn free_memory_bytes(page: u64) -> Option<u64> {
    let mut vm: libc::vm_statistics64 = unsafe { std::mem::zeroed() };
    let mut count = libc::HOST_VM_INFO64_COUNT;
    let rc = unsafe {
        libc::host_statistics64(
            libc::mach_host_self(),
            libc::HOST_VM_INFO64,
            &mut vm as *mut _ as libc::host_info64_t,
            &mut count,
        )
    };
    if rc != 0 {
        return None;
    }
    Some(vm.free_count as u64 * page)
}

#[cfg(target_os = "linux")]
fn free_memory_bytes(_page: u64) -> Option<u64> {
    let s = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kb = |key: &str| {
        s.lines()
            .find_map(|l| l.strip_prefix(key))
            .and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
    };
    kb("MemAvailable:")
        .or_else(|| kb("MemFree:"))
        .map(|k| k * 1024)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn free_memory_bytes(_page: u64) -> Option<u64> {
    None
}

/// `os.cpus().length` — logical CPUs on the host, which is what libuv's
/// `uv_cpu_info` counts. Deliberately NOT `available_parallelism`: that
/// answers with a cgroup quota or affinity mask when one is set, so a
/// container would report a different number from Node on the same host.
pub fn cpu_count() -> Option<i64> {
    let n = unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) };
    if n > 0 {
        Some(n as i64)
    } else {
        std::thread::available_parallelism()
            .ok()
            .map(|n| n.get() as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_metrics_are_live_numbers_on_this_host() {
        let p = process_metrics();
        assert!(p.pid > 0);
        assert!(p.rss_mb.as_f64().unwrap_or(0.0) > 0.0, "{:?}", p.rss_mb);
        assert!(p.peak_rss_mb.as_f64().unwrap_or(0.0) >= p.rss_mb.as_f64().unwrap_or(0.0) * 0.5);
        assert!(p.user_cpu_seconds.as_f64().is_some());
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            assert!(p.threads.as_i64().unwrap_or(0) >= 1, "{:?}", p.threads);
            assert!(p.open_fds.as_i64().unwrap_or(0) >= 1, "{:?}", p.open_fds);
            assert!(p.virtual_mb.as_f64().unwrap_or(0.0) > 0.0);
        }
        // Serialises with JavaScript number spelling — no `12.0`.
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.starts_with("{\"pid\":"));
        assert!(!json.contains(".0,") && !json.contains(".0}"), "{json}");
    }

    #[test]
    fn host_memory_and_cpus_are_sane() {
        let m = host_memory();
        let total = m.total_bytes.expect("physical memory");
        assert!(total > 256 * 1024 * 1024);
        // Node always emits a number for both; a hand-written Mach or
        // /proc read that silently failed would otherwise pass as `null`.
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let free = m.free_bytes.expect("free memory");
            assert!(free > 0 && free <= total, "free {free} of {total}");
        }
        assert!(cpu_count().unwrap_or(0) >= 1);
    }

    #[test]
    fn mb_rounds_to_two_decimals_and_prints_like_javascript() {
        assert_eq!(mb(0).to_string(), "0");
        assert_eq!(mb(1024 * 1024).to_string(), "1");
        assert_eq!(mb(1_572_864).to_string(), "1.5");
        assert_eq!(mb(1_234_567).to_string(), "1.18");
    }
}
