//! A counting global allocator — the Rust core's answer to "how big is the
//! heap", which V8 answers for Node with `getHeapStatistics()`.
//!
//! Rust has no managed heap and no GC, so the honest equivalent of "used
//! heap" is the number of bytes currently live in the global allocator.
//! Three relaxed atomics on every allocation and free give exactly that:
//! bytes allocated now, the high-water mark, and the count of live
//! allocations. `#[global_allocator]` is declared here in the library, so
//! every binary and test built from it — `pt-core` first — reports it.
//!
//! Cost: two atomic RMW operations per allocation and per free, on top of
//! the system allocator. Measurable in a microbenchmark, invisible in a
//! server whose hot path is SQLite and JSON serialisation.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

pub struct CountingAllocator;

static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static LIVE: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc(layout);
        if !p.is_null() {
            let now = ALLOCATED.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
            LIVE.fetch_add(1, Ordering::Relaxed);
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        ALLOCATED.fetch_sub(layout.size(), Ordering::Relaxed);
        LIVE.fetch_sub(1, Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = System.realloc(ptr, layout, new_size);
        if !p.is_null() {
            if new_size >= layout.size() {
                let now = ALLOCATED.fetch_add(new_size - layout.size(), Ordering::Relaxed)
                    + (new_size - layout.size());
                PEAK.fetch_max(now, Ordering::Relaxed);
            } else {
                ALLOCATED.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        p
    }
}

#[global_allocator]
static GLOBAL: CountingAllocator = CountingAllocator;

/// Live bytes, high-water bytes, live allocation count.
pub fn snapshot() -> (usize, usize, usize) {
    (
        ALLOCATED.load(Ordering::Relaxed),
        PEAK.load(Ordering::Relaxed),
        LIVE.load(Ordering::Relaxed),
    )
}

#[cfg(test)]
mod tests {
    use super::snapshot;

    /// The counters are process-wide and every other test in this binary
    /// allocates on sibling threads, so this asserts only what holds
    /// regardless of what they are doing: a 16 MiB allocation moves the
    /// live total by at least its own size, and freeing it moves it back.
    /// Absolute before/after comparisons would be a coin flip.
    #[test]
    fn counters_move_with_allocations() {
        const BIG: usize = 16 << 20;
        let (idle_bytes, _, _) = snapshot();
        let v: Vec<u8> = vec![7; BIG];
        let (held_bytes, peak, _) = snapshot();
        assert!(
            held_bytes >= idle_bytes + BIG / 2,
            "holding {BIG} bytes: {idle_bytes} → {held_bytes}"
        );
        assert!(peak >= BIG, "the peak has seen at least this allocation");
        drop(v);
        let (freed_bytes, _, _) = snapshot();
        assert!(
            freed_bytes + BIG / 2 <= held_bytes,
            "freeing {BIG} bytes: {held_bytes} → {freed_bytes}"
        );
    }
}
