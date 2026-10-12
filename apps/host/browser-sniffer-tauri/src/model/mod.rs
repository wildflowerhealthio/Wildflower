//! Wire-shape decoders for the web→host control events this crate listens
//! to. Each struct mirrors the TS schema in
//! `apps/host/recorder/recorder-core-js/src/bridge.ts`; drift surfaces as a
//! `serde_json::from_str` decode failure (warned-and-dropped by the handler).

pub(crate) mod open;
pub(crate) mod web_view_source;
