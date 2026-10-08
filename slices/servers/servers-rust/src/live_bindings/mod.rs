//! A server as the unit runner runs it: [`ServerUnit`](server_unit::ServerUnit),
//! bound to `wildflower-server-rust`, and
//! [`ServerConsentDecider`](server_consent_decider::ServerConsentDecider), how
//! the host decides a run's consents, bound to `gatekeeper-rust`.

pub mod server_consent_decider;
pub mod server_unit;
