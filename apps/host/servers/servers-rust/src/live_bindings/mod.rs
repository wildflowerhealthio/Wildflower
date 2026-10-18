//! A server as the unit runner runs it: [`ServerUnit`](server_unit::ServerUnit),
//! bound to `wildflower-server-rust`;
//! [`ServerLaunchMinter`](server_launch_minter::ServerLaunchMinter), how the
//! host mints a run's launches, and
//! [`ServerSignInCodeMinter`](server_sign_in_code_minter::ServerSignInCodeMinter),
//! how it mints the codes it signs a launch's browser in with, and
//! [`ServerConsentWatcher`](server_consent_watcher::ServerConsentWatcher), how
//! it waits for a consent it opened to settle, and
//! [`ServerConsentDenier`](server_consent_denier::ServerConsentDenier), how it
//! denies one from its notification, all bound to
//! `authorization-server-rust`.

pub mod server_consent_denier;
pub mod server_consent_watcher;
pub mod server_launch_minter;
pub mod server_sign_in_code_minter;
pub mod server_unit;
