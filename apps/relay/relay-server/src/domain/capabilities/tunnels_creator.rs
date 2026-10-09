//! The create capability — [`TunnelsCreator`], for `POST /api/tunnels`.
//!
//! It holds the decisions a create makes before anything is served: whether
//! the email is usable, whether the name is a usable, unreserved DNS label
//! not already stored (or a fresh default from [`names`]), and minting the
//! token. Only then does it read the clock and write the store, so a refused
//! request never depends on the clock. Serving the new tunnel, and undoing
//! the store write if that fails, is the registry's.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL;
use base64::Engine;
use rand::Rng;
use rathole_settings_rust::is_dns_label;

use crate::domain::{names, StoredTunnel, Tunnel, TunnelError, TunnelStore};
use crate::settings::{FrontSettings, Secret};

/// How many random bytes make a created tunnel's token.
pub(crate) const TOKEN_BYTES: usize = 32;

/// The longest email accepted, in bytes.
const MAX_EMAIL_LEN: usize = 254;

/// Creation — `POST /api/tunnels`. Holds the store and the front's settings
/// (for reserved names and public hosts), lifted from the state.
pub(crate) struct TunnelsCreator<S: TunnelStore> {
    store: S,
    front: FrontSettings,
}

impl<S: TunnelStore> TunnelsCreator<S> {
    pub(crate) fn new(store: S, front: FrontSettings) -> Self {
        Self { store, front }
    }

    /// Create and store a tunnel for `email`, named `name` or, without one,
    /// two random words (see [`names`]), with a random token from `rng`,
    /// created at the time `now` reads (Unix epoch seconds). Returns the
    /// stored tunnel, whose token is shown only to the caller of
    /// `POST /api/tunnels`.
    ///
    /// # Errors
    ///
    /// [`TunnelError::InvalidEmail`], [`InvalidName`](TunnelError::InvalidName),
    /// [`Reserved`](TunnelError::Reserved), [`Taken`](TunnelError::Taken) or
    /// [`Exhausted`](TunnelError::Exhausted), before `now` is read and with
    /// nothing stored; then whatever `now` fails with;
    /// [`Taken`](TunnelError::Taken), with nothing stored, if the store
    /// already has the name when it is written; and
    /// [`TunnelError::Infrastructure`] if the store read or write fails.
    pub(crate) fn create<R: Rng + ?Sized>(
        &self,
        email: &str,
        name: Option<&str>,
        rng: &mut R,
        now: impl FnOnce() -> Result<i64, TunnelError>,
    ) -> Result<StoredTunnel, TunnelError> {
        let email = valid_email(email).ok_or(TunnelError::InvalidEmail)?;
        let front = &self.front;
        let name = match name {
            Some(name) if !is_dns_label(name) => return Err(TunnelError::InvalidName),
            Some(name) if front.is_reserved(name) => return Err(TunnelError::Reserved),
            Some(name) if self.store.contains_tunnel(name)? => return Err(TunnelError::Taken),
            Some(name) => name.to_owned(),
            None => names::generate_unused(rng, |name| {
                Ok::<_, TunnelError>(front.is_reserved(name) || self.store.contains_tunnel(name)?)
            })?
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
            created_at: now()?,
        };
        if !self.store.insert_tunnel(&stored)? {
            return Err(TunnelError::Taken);
        }
        Ok(stored)
    }

    /// Take back a tunnel [`Self::create`] stored, when serving the change
    /// failed.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] if the store write fails.
    pub(crate) fn undo(&self, created: &StoredTunnel) -> Result<(), TunnelError> {
        self.store.delete_tunnel(&created.tunnel.name).map(drop)
    }

    /// `<name>.<domain>`, where the tunnel named `name` is served.
    pub(crate) fn public_host(&self, name: &str) -> String {
        self.front.public_host(name)
    }
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
    use crate::test_support::settings;

    /// A creator for `relay.example.com` over `store`.
    fn creator<S: TunnelStore>(store: S) -> TunnelsCreator<S> {
        let front = settings(std::path::Path::new("/nonexistent"), None).front;
        TunnelsCreator::new(store, front)
    }

    /// A store holding `alice`.
    fn with_alice() -> FakeTunnelStore {
        let store = FakeTunnelStore::default();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        store
    }

    fn create<S: TunnelStore>(
        creator: &TunnelsCreator<S>,
        email: &str,
        name: Option<&str>,
    ) -> Result<StoredTunnel, TunnelError> {
        let mut rng = StdRng::seed_from_u64(0);
        creator.create(email, name, &mut rng, || Ok(1))
    }

    #[test]
    fn create_stores_the_tunnel() {
        let creator = creator(with_alice());
        let stored = create(&creator, " bob@example.com ", Some("bob")).unwrap();
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
        assert_eq!(
            creator.store.list_tunnels().unwrap(),
            [stored_tunnel("alice"), stored.clone()]
        );
        assert_eq!(creator.public_host("bob"), "bob.relay.example.com");

        creator.undo(&stored).unwrap();
        assert_eq!(
            creator.store.list_tunnels().unwrap(),
            [stored_tunnel("alice")]
        );
    }

    /// A default name already stored is drawn again.
    #[test]
    fn a_default_name_already_stored_is_drawn_again() {
        let first = names::generate(&mut StdRng::seed_from_u64(0));
        let store = FakeTunnelStore::default();
        store.insert_tunnel(&stored_tunnel(&first)).unwrap();
        let creator = creator(store);
        let created = create(&creator, "bob@example.com", None).unwrap();
        assert_ne!(created.tunnel.name, first);
        assert_eq!(creator.store.list_tunnels().unwrap().len(), 2);
    }

    /// A store that has a tunnel but says it has none, as if another writer
    /// stored it between the check and the write.
    struct Racing(FakeTunnelStore);

    impl TunnelStore for Racing {
        fn list_tunnels(&self) -> Result<Vec<StoredTunnel>, TunnelError> {
            self.0.list_tunnels()
        }

        fn contains_tunnel(&self, _: &str) -> Result<bool, TunnelError> {
            Ok(false)
        }

        fn insert_tunnel(&self, stored: &StoredTunnel) -> Result<bool, TunnelError> {
            self.0.insert_tunnel(stored)
        }

        fn delete_tunnel(&self, name: &str) -> Result<Option<StoredTunnel>, TunnelError> {
            self.0.delete_tunnel(name)
        }
    }

    /// A name the store refuses when it is written is taken, and nothing is
    /// stored.
    #[test]
    fn a_name_the_store_already_has_is_taken() {
        let creator = creator(Racing(with_alice()));
        let result = create(&creator, "bob@example.com", Some("alice"));
        assert_eq!(result.unwrap_err(), TunnelError::Taken);
        assert_eq!(
            creator.store.list_tunnels().unwrap(),
            [stored_tunnel("alice")]
        );
    }

    #[test]
    fn create_validates_the_name_and_email() {
        let creator = creator(with_alice());
        for (email, name) in [
            ("bob@example.com", "Bob"),
            ("bob@example.com", "bob.example"),
            ("bob@example.com", "-bob"),
            ("bob@example.com", ""),
        ] {
            let result = create(&creator, email, Some(name));
            assert_eq!(result.unwrap_err(), TunnelError::InvalidName, "{name:?}");
        }
        for email in ["", "bob", "@example.com", "bob@", "bob @example.com"] {
            let result = create(&creator, email, Some("bob"));
            assert_eq!(result.unwrap_err(), TunnelError::InvalidEmail, "{email:?}");
        }
        let long_local = "b".repeat(MAX_EMAIL_LEN);
        let result = create(&creator, &format!("{long_local}@x"), Some("bob"));
        assert_eq!(result.unwrap_err(), TunnelError::InvalidEmail);
        let result = create(&creator, "bob@example.com", Some("admin"));
        assert_eq!(result.unwrap_err(), TunnelError::Reserved);
        let result = create(&creator, "bob@example.com", Some("alice"));
        assert_eq!(result.unwrap_err(), TunnelError::Taken);
        assert_eq!(
            creator.store.list_tunnels().unwrap().len(),
            1,
            "nothing stored"
        );
    }

    /// A refused request is refused before the clock is read, so a clock
    /// failure can't turn a `422` or `409` into a `500`.
    #[test]
    fn refusals_come_before_the_clock() {
        let creator = creator(with_alice());
        let clock_failed = || -> Result<i64, TunnelError> {
            Err(TunnelError::infrastructure(
                "reading the clock failed",
                "boom",
            ))
        };
        for (email, name, expected) in [
            ("not an email", Some("bob"), TunnelError::InvalidEmail),
            ("bob@example.com", Some("Bob"), TunnelError::InvalidName),
            ("bob@example.com", Some("admin"), TunnelError::Reserved),
            ("bob@example.com", Some("alice"), TunnelError::Taken),
        ] {
            let mut rng = StdRng::seed_from_u64(0);
            let result = creator.create(email, name, &mut rng, clock_failed);
            assert_eq!(result.unwrap_err(), expected, "{email:?} {name:?}");
        }
        let mut rng = StdRng::seed_from_u64(0);
        let result = creator.create("bob@example.com", Some("bob"), &mut rng, clock_failed);
        assert!(matches!(
            result.unwrap_err(),
            TunnelError::Infrastructure { .. }
        ));
        assert_eq!(
            creator.store.list_tunnels().unwrap().len(),
            1,
            "nothing stored"
        );
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
            let creator = creator(FakeTunnelStore::default());
            let email = format!("{local}@{domain}.example");
            let mut rng = StdRng::seed_from_u64(seed);
            let created = creator.create(&email, None, &mut rng, || Ok(1)).unwrap();
            let name = &created.tunnel.name;
            prop_assert!(is_dns_label(name));
            prop_assert!(!name.contains(&local), "{}", name);
            prop_assert!(!name.contains(&domain), "{}", name);
        }
    }
}
