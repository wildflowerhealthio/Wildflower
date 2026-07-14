//! Domain actions over the [`GatekeeperStore`](crate::domain::GatekeeperStore) port
//! — the seam the HTTP routes (and the boot/state machinery) call instead of
//! touching a concrete store. Each function takes `&impl GatekeeperStore`, so it
//! runs against the `SQLite` adapter in production and against the in-memory
//! [`FakeGatekeeperStore`](test_fake::FakeGatekeeperStore) in tests, with no
//! database or HTTP layer in the way.
//!
//! One file per domain entity, mirroring the apps slice's `domain/actions/` folder:
//!
//!  - [`client`] / [`signing_key`] / [`authorization_code`] / [`refresh_token`] —
//!    thin relays a handler calls so it never names a store method directly;
//!  - [`authorization_request`] — the request lifecycle relays plus the two
//!    semantic consent loaders (the `*ConsentNotFound` mapping + parse-don't-validate
//!    unwrap into [`PendingCodeConsent`](crate::domain::PendingCodeConsent));
//!  - [`grant`] — the grant reads/upserts plus the semantic `get_grant` / `revoke_grant`.
//!
//! Semantic actions carry the logic the unit tests exercise (against
//! [`test_fake`]); pure crypto/HTTP logic (PKCE, token minting, JWK, cookies) stays
//! in `crate::http` — only the store-touching step lives here.

mod authorization_code;
mod authorization_request;
mod client;
mod grant;
mod refresh_token;
mod signing_key;

#[cfg(test)]
mod test_fake;

pub(crate) use authorization_code::{
    authorization_code_by_request_id, issue_authorization_code, redeem_authorization_code,
};
pub(crate) use authorization_request::{
    approve_authorization_request, authorization_request_by_id, authorization_request_by_user_code,
    authorization_request_for_status, consume_approved_authorization_request,
    deny_authorization_request, insert_authorization_request,
    load_pending_authorization_code_request, load_pending_device_request,
    oldest_pending_device_user_code, record_device_poll,
};
pub(crate) use client::client_by_id;
pub(crate) use grant::{
    all_grants, device_grant_by_client_and_device_name, get_grant, grant_by_client_and_redirect,
    revoke_grant, upsert_authorization_code_grant, upsert_device_grant,
};
pub(crate) use refresh_token::{
    expire_refresh_token_families_for_authorization_code, expire_refresh_token_family,
    insert_refresh_token_family, refresh_token_with_family_by_hash, rotate_refresh_token,
};
pub(crate) use signing_key::{active_signing_key, all_signing_keys, has_active_signing_key};
