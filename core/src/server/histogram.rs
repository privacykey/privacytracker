//! A latency histogram with the shape Node's `perf_hooks` `IntervalHistogram`
//! reports through `snapshotSchedulerLag`: count, min, mean, max, stddev and
//! the p50/p95/p99 percentiles, accumulated since start (or reset) rather
//! than over a sliding window.
//!
//! Log-linear buckets over microseconds — 64 linear buckets below 64 µs,
//! then 64 sub-buckets per power of two — give ~1.6 % precision at every
//! magnitude for 30 KB, with no dependency. Percentiles report the bucket's
//! upper bound, as HDR's `valueAtPercentile` reports the highest equivalent
//! value. Min and max are exact.
//!
//! One histogram serves two readings: scheduler lag (the tokio analogue of
//! event-loop delay) and the wait to acquire the single SQLite connection.

use serde::Serialize;
use serde_json::Value;

use crate::jsnum::js_number;

const LINEAR: usize = 64;
const SUB_BITS: u32 = 6;
const SUB: usize = 1 << SUB_BITS;
/// Values above this (≈ 12.7 days in µs) saturate; nothing waits that long.
const MAX_VALUE: u64 = 1 << 40;
const BUCKETS: usize = LINEAR + (40 - 6 + 1) * SUB;

pub struct LagHistogram {
    buckets: Vec<u64>,
    count: u64,
    sum: f64,
    sum_sq: f64,
    min: u64,
    max: u64,
    started_at_ms: i64,
}

impl LagHistogram {
    pub fn new(now_ms: i64) -> Self {
        LagHistogram {
            buckets: vec![0; BUCKETS],
            count: 0,
            sum: 0.0,
            sum_sq: 0.0,
            min: u64::MAX,
            max: 0,
            started_at_ms: now_ms,
        }
    }

    /// `histogram.reset()` — counts cleared, the window restarted.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn reset(&mut self, now_ms: i64) {
        *self = LagHistogram::new(now_ms);
    }

    fn index(v: u64) -> usize {
        if v < LINEAR as u64 {
            return v as usize;
        }
        let e = (63 - v.leading_zeros()) as usize; // floor(log2 v), ≥ 6
        let sub = ((v >> (e - SUB_BITS as usize)) & (SUB as u64 - 1)) as usize;
        LINEAR + (e - 6) * SUB + sub
    }

    fn upper_bound(idx: usize) -> u64 {
        if idx < LINEAR {
            return idx as u64;
        }
        let group = (idx - LINEAR) / SUB;
        let sub = ((idx - LINEAR) % SUB) as u64;
        let e = group + 6;
        ((SUB as u64 + sub + 1) << (e - 6)) - 1
    }

    pub fn record_micros(&mut self, micros: u64) {
        let v = micros.min(MAX_VALUE - 1);
        self.buckets[Self::index(v)] += 1;
        self.count += 1;
        let f = v as f64;
        self.sum += f;
        self.sum_sq += f * f;
        self.min = self.min.min(v);
        self.max = self.max.max(v);
    }

    pub fn count(&self) -> u64 {
        self.count
    }

    fn percentile_micros(&self, p: f64) -> u64 {
        if self.count == 0 {
            return 0;
        }
        let target = ((p / 100.0) * self.count as f64).ceil().max(1.0) as u64;
        let mut seen = 0u64;
        for (i, n) in self.buckets.iter().enumerate() {
            seen += n;
            if seen >= target {
                return Self::upper_bound(i).min(self.max);
            }
        }
        self.max
    }

    /// The envelope's `LagSnapshot`, in the key order Node writes it.
    pub fn snapshot(&self, now_ms: i64) -> LagSnapshot {
        let ms = |micros: u64| js_number(micros as f64 / 1000.0);
        let p99 = self.percentile_micros(99.0) as f64 / 1000.0;
        let (mean, stddev) = if self.count > 0 {
            let mean = self.sum / self.count as f64;
            let var = (self.sum_sq / self.count as f64 - mean * mean).max(0.0);
            (js_number(mean / 1000.0), js_number(var.sqrt() / 1000.0))
        } else {
            (Value::Null, Value::Null)
        };
        LagSnapshot {
            window_seconds: ((now_ms - self.started_at_ms).max(0) as f64 / 1000.0).round() as i64,
            samples: self.count,
            min_ms: if self.count > 0 {
                ms(self.min)
            } else {
                js_number(0.0)
            },
            mean_ms: mean,
            max_ms: ms(self.max),
            stddev_ms: stddev,
            p50_ms: ms(self.percentile_micros(50.0)),
            p95_ms: ms(self.percentile_micros(95.0)),
            p99_ms: js_number(p99),
            severity: lag_severity(p99),
        }
    }
}

/// `lagSeverity` in lib/runtime-diagnostics.ts: p99 ≥ 1 s is beach-balling,
/// ≥ 100 ms is jank.
pub fn lag_severity(p99_ms: f64) -> &'static str {
    if p99_ms >= 1000.0 {
        "danger"
    } else if p99_ms >= 100.0 {
        "warn"
    } else {
        "ok"
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct LagSnapshot {
    #[serde(rename = "windowSeconds")]
    pub window_seconds: i64,
    pub samples: u64,
    #[serde(rename = "minMs")]
    pub min_ms: Value,
    #[serde(rename = "meanMs")]
    pub mean_ms: Value,
    #[serde(rename = "maxMs")]
    pub max_ms: Value,
    #[serde(rename = "stddevMs")]
    pub stddev_ms: Value,
    #[serde(rename = "p50Ms")]
    pub p50_ms: Value,
    #[serde(rename = "p95Ms")]
    pub p95_ms: Value,
    #[serde(rename = "p99Ms")]
    pub p99_ms: Value,
    pub severity: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_mapping_is_monotonic_and_bounded() {
        let mut last = 0usize;
        for v in [
            0u64,
            1,
            63,
            64,
            65,
            127,
            128,
            1000,
            65_535,
            1 << 20,
            1 << 30,
            MAX_VALUE - 1,
        ] {
            let i = LagHistogram::index(v);
            assert!(i >= last, "{v}");
            assert!(i < BUCKETS, "{v} → {i}");
            assert!(
                LagHistogram::upper_bound(i) >= v,
                "{v} ≤ ub({i})={}",
                LagHistogram::upper_bound(i)
            );
            last = i;
        }
        assert_eq!(LagHistogram::upper_bound(LagHistogram::index(63)), 63);
        // Precision: the bucket holding 1_000_000 µs ends within 1.6 % of it.
        let ub = LagHistogram::upper_bound(LagHistogram::index(1_000_000));
        assert!(ub < 1_016_000, "{ub}");
    }

    #[test]
    fn empty_histogram_has_null_mean_and_zero_min_like_the_node_snapshot() {
        let h = LagHistogram::new(1_000);
        let s = h.snapshot(4_000);
        assert_eq!(s.samples, 0);
        assert_eq!(s.window_seconds, 3);
        assert_eq!(s.min_ms, js_number(0.0));
        assert_eq!(s.mean_ms, Value::Null);
        assert_eq!(s.stddev_ms, Value::Null);
        assert_eq!(s.p99_ms, js_number(0.0));
        assert_eq!(s.severity, "ok");
    }

    #[test]
    fn percentiles_and_moments_track_the_samples() {
        let mut h = LagHistogram::new(0);
        for v in 1..=1000u64 {
            h.record_micros(v * 1000); // 1 ms … 1000 ms
        }
        let s = h.snapshot(0);
        assert_eq!(s.samples, 1000);
        assert_eq!(s.min_ms, js_number(1.0));
        assert_eq!(s.max_ms, js_number(1000.0));
        let f = |v: &Value| v.as_f64().unwrap();
        assert!((f(&s.mean_ms) - 500.5).abs() < 0.01);
        assert!((f(&s.stddev_ms) - 288.67).abs() < 0.1);
        // Log-linear buckets: within ~2 % of the exact percentile.
        assert!((f(&s.p50_ms) - 500.0).abs() < 10.0, "{}", f(&s.p50_ms));
        assert!((f(&s.p99_ms) - 990.0).abs() < 20.0, "{}", f(&s.p99_ms));
        assert_eq!(s.severity, "warn");
        h.reset(5_000);
        assert_eq!(h.count(), 0);
    }

    #[test]
    fn severity_thresholds_match_node() {
        assert_eq!(lag_severity(99.9), "ok");
        assert_eq!(lag_severity(100.0), "warn");
        assert_eq!(lag_severity(999.9), "warn");
        assert_eq!(lag_severity(1000.0), "danger");
    }
}
