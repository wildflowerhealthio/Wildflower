//! A server as the unit runner runs it: [`ServerUnit`](server_unit::ServerUnit),
//! bound to `wildflower-server-rust`, and
//! [`RunningServerConsents`](running_server_consents::RunningServerConsents),
//! the running servers' consents, bound to `gatekeeper-rust`.

pub mod running_server_consents;
pub mod server_unit;
