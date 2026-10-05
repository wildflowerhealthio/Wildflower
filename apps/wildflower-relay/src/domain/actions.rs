//! The tunnel domain actions over the [`TunnelStore`] port —
//! [`create_tunnel`] and [`delete_tunnel`], the seam the
//! [`TunnelRegistry`](crate::tunnel_registry::TunnelRegistry) calls instead of
//! touching a concrete store. Each takes `&impl TunnelStore` and the live
//! [`TunnelSet`], so it runs against the `SQLite` adapter in production and
//! against an in-memory fake in tests, with no database, rathole or HTTP
//! layer in the way.
//!
//! They hold the decisions a change makes before anything is served: whether
//! the name is a usable, unreserved, untaken DNS label (or a fresh default
//! from [`names`]), whether the email is usable,
//! minting the token, and whether a tunnel may be deleted at all. Each writes
//! the store and hands back the set to serve next; rendering and serving that
//! set, and undoing the store write if that fails, is the registry's.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL;
use base64::Engine;
use rand::Rng;

use crate::domain::{names, StoredTunnel, TunnelError, TunnelSet, TunnelStore};
use crate::route::is_dns_label;
use crate::settings::{FrontSettings, Secret, Tunnel};

/// How many random bytes make a created tunnel's token.
const TOKEN_BYTES: usize = 32;

/// The longest email accepted, in bytes.
const MAX_EMAIL_LEN: usize = 254;

/// Create and store a tunnel for `email`, named `name` or, without one, two
/// random words (see [`names`]), with a random token from `rng`, created at
/// `created_at` (Unix epoch seconds). Returns the stored tunnel (whose token
/// is shown only to the caller of `POST /api/tunnels`) and `live` with it
/// added on the next port.
///
/// # Errors
///
/// [`TunnelError::InvalidEmail`], [`InvalidName`](TunnelError::InvalidName),
/// [`Reserved`](TunnelError::Reserved), [`Taken`](TunnelError::Taken) or
/// [`Exhausted`](TunnelError::Exhausted), with nothing stored;
/// [`TunnelError::Infrastructure`] if the store write fails.
pub fn create_tunnel<R: Rng + ?Sized>(
    store: &impl TunnelStore,
    live: &TunnelSet,
    front: &FrontSettings,
    email: &str,
    name: Option<&str>,
    rng: &mut R,
    created_at: i64,
) -> Result<(StoredTunnel, TunnelSet), TunnelError> {
    let email = valid_email(email).ok_or(TunnelError::InvalidEmail)?;
    let name = match name {
        Some(name) if !is_dns_label(name) => return Err(TunnelError::InvalidName),
        Some(name) if front.is_reserved(name) => return Err(TunnelError::Reserved),
        Some(name) if live.get(name).is_some() => return Err(TunnelError::Taken),
        Some(name) => name.to_owned(),
        None => names::generate_unused(rng, |name| {
            live.get(name).is_some() || front.is_reserved(name)
        })
        .ok_or(TunnelError::Exhausted("no unused tunnel name was drawn"))?,
    };
    let mut token = [0; TOKEN_BYTES];
    rng.fill_bytes(&mut token);
    let stored = StoredTunnel {
        tunnel: Tunnel {
            name,
            token: Secret::new(BASE64_URL.encode(token)),
        },
        email,
        created_at,
    };

    let mut next = live.clone();
    next.add(
        stored.tunnel.clone(),
        Some((stored.email.clone(), stored.created_at)),
    )
    .map_err(|_| TunnelError::Exhausted("no loopback port is left"))?;
    store.insert_tunnel(&stored)?;
    Ok((stored, next))
}

/// Delete the stored tunnel named `name`. Returns what was stored (for
/// putting back should serving the change fail) and `live` without it.
///
/// # Errors
///
/// [`TunnelError::NotFound`] or
/// [`FromEnvironment`](TunnelError::FromEnvironment), with nothing deleted;
/// [`TunnelError::Infrastructure`] if the store write fails.
pub fn delete_tunnel(
    store: &impl TunnelStore,
    live: &TunnelSet,
    name: &str,
) -> Result<(StoredTunnel, TunnelSet), TunnelError> {
    let live_tunnel = live.get(name).ok_or(TunnelError::NotFound)?;
    let Some((email, created_at)) = live_tunnel.stored.clone() else {
        return Err(TunnelError::FromEnvironment);
    };
    let stored = StoredTunnel {
        tunnel: live_tunnel.tunnel.clone(),
        email,
        created_at,
    };

    let mut next = live.clone();
    next.remove(name);
    // A miss means the row is already gone, which is what deleting wants.
    store.delete_tunnel(name)?;
    Ok((stored, next))
}

/// `email` trimmed, if it is at most [`MAX_EMAIL_LEN`] bytes of `local@domain`
/// with neither part empty and no whitespace or control characters. The
/// email only records who a tunnel belongs to, so this is not a full RFC
/// 5322 check.
fn valid_email(email: &str) -> Option<String> {
    let email = email.trim();
    let (local, domain) = email.rsplit_once('@')?;
    let valid = email.len() <= MAX_EMAIL_LEN
        && !local.is_empty()
        && !domain.is_empty()
        && !email.chars().any(|c| c.is_whitespace() || c.is_control());
    valid.then(|| email.to_owned())
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    use super::*;
    use crate::domain::test_fake::{stored_tunnel, FakeTunnelStore};
    use crate::domain::Source;
    use crate::settings::RelaySettings;
    use crate::test_support::settings;

    /// The settings for `relay.example.com` with `tunnels` in the environment.
    fn relay(tunnels: &str) -> RelaySettings {
        settings(std::path::Path::new("/nonexistent"), tunnels, 5201, None)
    }

    /// The live set of `relay` with whatever `store` holds.
    fn live(relay: &RelaySettings, store: &FakeTunnelStore) -> TunnelSet {
        TunnelSet::new(&relay.control, store.list_tunnels().unwrap()).unwrap()
    }

    fn create(
        store: &FakeTunnelStore,
        relay: &RelaySettings,
        email: &str,
        name: Option<&str>,
    ) -> Result<(StoredTunnel, TunnelSet), TunnelError> {
        let live = live(relay, store);
        let mut rng = StdRng::seed_from_u64(0);
        create_tunnel(store, &live, &relay.front, email, name, &mut rng, 1)
    }

    #[test]
    fn create_stores_the_tunnel_and_adds_it_on_the_next_port() {
        let relay = relay("alice=t1");
        let store = FakeTunnelStore::default();
        let (stored, next) = create(&store, &relay, " bob@example.com ", Some("bob")).unwrap();
        assert_eq!(stored.tunnel.name, "bob");
        assert_eq!(stored.email, "bob@example.com");
        assert_eq!(stored.created_at, 1);
        assert_eq!(
            BASE64_URL
                .decode(stored.tunnel.token.expose())
                .unwrap()
                .len(),
            TOKEN_BYTES
        );
        assert_eq!(store.list_tunnels().unwrap(), std::slice::from_ref(&stored));

        let bob = next.get("bob").unwrap();
        assert_eq!(bob.port, 5202);
        assert_eq!(bob.source(), Source::Store);
        assert_eq!(next.len(), 2);
    }

    #[test]
    fn create_validates_the_name_and_email() {
        let relay = relay("alice=t1");
        let store = FakeTunnelStore::default();
        for (email, name) in [
            ("bob@example.com", "Bob"),
            ("bob@example.com", "bob.example"),
            ("bob@example.com", "-bob"),
            ("bob@example.com", ""),
        ] {
            let result = create(&store, &relay, email, Some(name));
            assert_eq!(result.unwrap_err(), TunnelError::InvalidName, "{name:?}");
        }
        for email in ["", "bob", "@example.com", "bob@", "bob @example.com"] {
            let result = create(&store, &relay, email, Some("bob"));
            assert_eq!(result.unwrap_err(), TunnelError::InvalidEmail, "{email:?}");
        }
        let long_local = "b".repeat(MAX_EMAIL_LEN);
        let result = create(&store, &relay, &format!("{long_local}@x"), Some("bob"));
        assert_eq!(result.unwrap_err(), TunnelError::InvalidEmail);
        let result = create(&store, &relay, "bob@example.com", Some("admin"));
        assert_eq!(result.unwrap_err(), TunnelError::Reserved);
        let result = create(&store, &relay, "bob@example.com", Some("alice"));
        assert_eq!(result.unwrap_err(), TunnelError::Taken);
        assert!(store.list_tunnels().unwrap().is_empty(), "nothing stored");

        create(&store, &relay, "bob@example.com", Some("bob")).unwrap();
        let result = create(&store, &relay, "carol@example.com", Some("bob"));
        assert_eq!(result.unwrap_err(), TunnelError::Taken);
        assert_eq!(store.list_tunnels().unwrap().len(), 1);
    }

    #[test]
    fn create_without_a_free_port_stores_nothing() {
        let relay = settings(
            std::path::Path::new("/nonexistent"),
            "alice=t1",
            65535,
            None,
        );
        let store = FakeTunnelStore::default();
        let live = live(&relay, &store);
        let mut rng = StdRng::seed_from_u64(0);
        let result = create_tunnel(
            &store,
            &live,
            &relay.front,
            "bob@example.com",
            Some("bob"),
            &mut rng,
            1,
        );
        assert_eq!(
            result.unwrap_err(),
            TunnelError::Exhausted("no loopback port is left")
        );
        assert!(store.list_tunnels().unwrap().is_empty());
    }

    #[test]
    fn delete_removes_a_stored_tunnel_but_not_one_from_the_environment() {
        let relay = relay("alice=t1");
        let store = FakeTunnelStore::default();
        store.insert_tunnel(&stored_tunnel("bob")).unwrap();
        let live = live(&relay, &store);

        assert_eq!(
            delete_tunnel(&store, &live, "alice").unwrap_err(),
            TunnelError::FromEnvironment
        );
        assert_eq!(
            delete_tunnel(&store, &live, "nobody").unwrap_err(),
            TunnelError::NotFound
        );
        assert_eq!(store.list_tunnels().unwrap().len(), 1);

        let (deleted, next) = delete_tunnel(&store, &live, "bob").unwrap();
        assert_eq!(deleted, stored_tunnel("bob"));
        assert!(store.list_tunnels().unwrap().is_empty());
        assert!(next.get("bob").is_none());
        assert!(next.get("alice").is_some());
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(32))]

        /// A default name is a DNS label and contains no fragment of the
        /// email it was created for. The fragments are longer than any
        /// listed word, so only a name built from the email could match.
        #[test]
        fn default_names_never_contain_fragments_of_the_email(
            local in "[a-z0-9]{6,20}",
            domain in "[a-z0-9]{6,20}",
            seed: u64,
        ) {
            let relay = relay("");
            let store = FakeTunnelStore::default();
            let live = live(&relay, &store);
            let email = format!("{local}@{domain}.example");
            let mut rng = StdRng::seed_from_u64(seed);
            let (created, _) =
                create_tunnel(&store, &live, &relay.front, &email, None, &mut rng, 1).unwrap();
            let name = &created.tunnel.name;
            prop_assert!(is_dns_label(name));
            prop_assert!(!name.contains(&local), "{}", name);
            prop_assert!(!name.contains(&domain), "{}", name);
        }
    }
}
