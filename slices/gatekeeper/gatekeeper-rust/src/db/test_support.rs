//! Shared proptest strategies for the per-table store round-trip tests.
//!
//! Every generated value must survive a `SQLite` write/read unchanged, so the
//! generators are deliberately conservative: timestamps come from whole
//! millisecond epochs (rusqlite stores `DateTime<Utc>` as `%F %T%.f%:z`, which
//! round-trips sub-second digits exactly, but bounding the range keeps the
//! Debug output readable on failure) and URLs are assembled from
//! already-valid components so `Url::parse` never rejects them.

use chrono::{DateTime, TimeZone, Utc};
use proptest::prelude::*;
use url::Url;

/// A `DateTime<Utc>` drawn from a plausible recent epoch window
/// (2000-01-01 to 2065-01-01). Built from a whole millisecond count so the
/// value round-trips through `SQLite`'s text timestamp encoding without
/// precision loss.
pub fn arb_timestamp() -> impl Strategy<Value = DateTime<Utc>> {
    let window_start = Utc
        .with_ymd_and_hms(2000, 1, 1, 0, 0, 0)
        .single()
        .expect("valid window start")
        .timestamp_millis();
    let window_end = Utc
        .with_ymd_and_hms(2065, 1, 1, 0, 0, 0)
        .single()
        .expect("valid window end")
        .timestamp_millis();
    (window_start..window_end).prop_map(|millis| {
        Utc.timestamp_millis_opt(millis)
            .single()
            .expect("valid epoch ms")
    })
}

/// An optional timestamp — covers both the present and absent branches of a
/// nullable `DateTime<Utc>` column.
pub fn arb_opt_timestamp() -> impl Strategy<Value = Option<DateTime<Utc>>> {
    prop::option::of(arb_timestamp())
}

/// A syntactically valid `https`/`http` `Url`, assembled from safe components
/// so the parse never fails and the canonical form matches what `SQLite` stores.
pub fn arb_url() -> impl Strategy<Value = Url> {
    (
        prop_oneof![Just("https"), Just("http")],
        "[a-z][a-z0-9-]{0,15}",
        "[a-z]{2,6}",
        prop::option::of("[a-z0-9/_-]{0,24}"),
    )
        .prop_map(|(scheme, host, tld, path)| {
            let path = path.unwrap_or_default();
            Url::parse(&format!("{scheme}://{host}.{tld}/{path}")).expect("valid url")
        })
}
