use chrono::{DateTime, Utc};

pub fn now() -> DateTime<Utc> {
    Utc::now()
}

pub fn add_seconds(t: DateTime<Utc>, secs: i64) -> DateTime<Utc> {
    t + chrono::Duration::seconds(secs)
}

pub fn to_iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn from_iso(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|dt| dt.with_timezone(&Utc))
}

pub fn to_epoch_seconds(t: DateTime<Utc>) -> i64 {
    t.timestamp()
}
