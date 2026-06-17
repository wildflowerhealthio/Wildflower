//! Wire-shape decoders for the three `CollectorBridge.webToHost` events
//! this crate listens to. Each struct mirrors a TS schema in
//! `slices/collector/collector-fundamentals/src/bridge.ts`; drift surfaces
//! as a `serde_json::from_str` decode failure (warned-and-dropped by the
//! handler).

pub(crate) mod payloads;
pub(crate) mod web_view_source;
