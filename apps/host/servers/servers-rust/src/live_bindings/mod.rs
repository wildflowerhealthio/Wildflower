//! A server as the unit runner runs it: [`ServerUnit`](server_unit::ServerUnit),
//! bound to `wildflower-server-rust`;
//! [`ServerConsentDecider`](server_consent_decider::ServerConsentDecider), how
//! the host decides a run's consents, and
//! [`ServerLaunchMinter`](server_launch_minter::ServerLaunchMinter), how it
//! mints a run's launches, and
//! [`ServerSignInCodeMinter`](server_sign_in_code_minter::ServerSignInCodeMinter),
//! how it mints the codes it signs a launch's browser in with, all bound to
//! `authorization-server-rust`.

pub mod server_consent_decider;
pub mod server_launch_minter;
pub mod server_sign_in_code_minter;
pub mod server_unit;
