use super::*;
use crate::db::test_support::{arb_opt_timestamp, arb_timestamp};
use crate::db::SqliteGatekeeperStore;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::{GatekeeperStore as _, GatekeeperTx as _};
use proptest::prelude::*;

fn arb_family() -> impl Strategy<Value = RefreshTokenFamily> {
    (
        "[a-zA-Z0-9-]{1,36}",
        "[a-zA-Z0-9_-]{1,32}",
        prop::collection::vec("[a-z][a-z0-9_/.*]{0,15}", 0..5),
        prop::option::of("[a-zA-Z0-9-]{1,32}"),
        arb_timestamp(),
        arb_timestamp(),
        prop::option::of("[A-Za-z0-9_-]{43}"),
        prop::option::of("[a-zA-Z0-9-]{1,36}"),
    )
        .prop_map(
            |(
                family_id,
                client_id,
                scopes,
                patient,
                issued_at,
                expires_at,
                authorization_code_hash,
                grant_id,
            )| {
                RefreshTokenFamily {
                    family_id,
                    client_id,
                    scopes,
                    patient,
                    issued_at,
                    expires_at,
                    authorization_code_hash,
                    grant_id,
                }
            },
        )
}

fn arb_token_in_family(family_id: &str) -> impl Strategy<Value = RefreshToken> {
    let family_id = family_id.to_string();
    ("[a-zA-Z0-9_-]{1,43}", arb_timestamp(), arb_opt_timestamp()).prop_map(
        move |(token_hash, issued_at, consumed_at)| RefreshToken {
            token_hash,
            family_id: family_id.clone(),
            issued_at,
            consumed_at,
        },
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn insert_and_fetch_round_trip(
        family in arb_family(),
        token in arb_token_in_family("family-under-test"),
    ) {
        let family = RefreshTokenFamily { family_id: "family-under-test".to_string(), ..family };
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        seed_family_with_token(&store, &family, &token);
        let (fetched_token, fetched_family) = store
            .refresh_token_with_family_by_hash(&token.token_hash)
            .expect("query")
            .expect("row present");
        prop_assert_eq!(fetched_token, token);
        prop_assert_eq!(fetched_family, family);
    }

    /// The guarded-update primitive is the whole atomicity of a consume:
    /// the first stamp of a live token wins (`true`), a second stamp of the
    /// now-consumed token loses the `consumed_at IS NULL` guard (`false`)
    /// while the row still exists — the SQL facts the domain assembles into
    /// `Consumed` then `Replayed`. (The three-state decision itself is
    /// tested against the action in `domain::refresh_token`.)
    #[test]
    fn stamp_consumes_live_then_loses_the_guard_on_replay(
        family in arb_family(),
        token in arb_token_in_family("family-under-test"),
    ) {
        let family = RefreshTokenFamily { family_id: "family-under-test".to_string(), ..family };
        let live = RefreshToken { consumed_at: None, ..token };
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        seed_family_with_token(&store, &family, &live);
        let now = Utc::now();
        prop_assert!(store
            .with_connection(|tx| tx.stamp_refresh_token_consumed_if_live(&live.token_hash, now))
            .expect("first stamp"));
        prop_assert!(!store
            .with_connection(|tx| tx.stamp_refresh_token_consumed_if_live(&live.token_hash, now))
            .expect("second stamp"));
        prop_assert!(store
            .with_connection(|tx| tx.refresh_token_exists(&live.token_hash))
            .expect("exists probe"));
    }
}

#[test]
fn unknown_hash_neither_stamps_nor_exists() {
    let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
    assert!(!store
        .with_connection(|tx| tx.stamp_refresh_token_consumed_if_live("never-issued", Utc::now()))
        .expect("stamp"));
    assert!(!store
        .with_connection(|tx| tx.refresh_token_exists("never-issued"))
        .expect("exists probe"));
}

// Foreign-key enforcement (`PRAGMA foreign_keys = ON`): a refresh token
// whose family does not exist is rejected at insert time instead of
// becoming an orphan that later reads as "not found" (so a genuine replay
// of such a token would fail to revoke anything). The store surfaces it as
// the opaque Backend whose text names the constraint.
#[test]
fn insert_refresh_token_rejects_orphan_without_family() {
    let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
    let err = store
        .insert_refresh_token(&sample_token("orphan", "no-such-family"))
        .expect_err("orphan insert must violate the foreign key");
    assert!(
        matches!(
            &err,
            GatekeeperError::Infrastructure { source, .. }
                if source.to_uppercase().contains("FOREIGN KEY")
        ),
        "expected a foreign-key constraint violation, got {err:?}"
    );
}

/// Seed a family and its first token — the two store primitives the
/// `insert_refresh_token_family` action sequences. Expressed as the
/// primitives here so these store-level tests don't reach up into the domain
/// layer for setup. (Rotation's own consume-then-insert orchestration is
/// tested against the action, in `domain::refresh_token`.)
fn seed_family_with_token(
    store: &SqliteGatekeeperStore,
    family: &RefreshTokenFamily,
    token: &RefreshToken,
) {
    store
        .insert_refresh_token_family_row(family)
        .expect("insert family row");
    store
        .insert_refresh_token(token)
        .expect("insert first token");
}

fn sample_family(family_id: &str, client_id: &str) -> RefreshTokenFamily {
    RefreshTokenFamily {
        family_id: family_id.to_string(),
        client_id: client_id.to_string(),
        scopes: vec!["read".to_string()],
        patient: None,
        issued_at: Utc::now(),
        expires_at: Utc::now() + chrono::Duration::days(90),
        authorization_code_hash: None,
        grant_id: None,
    }
}

fn sample_token(token_hash: &str, family_id: &str) -> RefreshToken {
    RefreshToken {
        token_hash: token_hash.to_string(),
        family_id: family_id.to_string(),
        issued_at: Utc::now(),
        consumed_at: None,
    }
}

#[test]
fn expire_family_pulls_deadline_back_and_stamps_the_live_token() {
    let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
    seed_family_with_token(
        &store,
        &sample_family("family-a", "client-1"),
        &sample_token("token-1", "family-a"),
    );
    store
        .insert_refresh_token(&sample_token("token-2", "family-a"))
        .expect("insert token-2");
    let untouched = sample_family("family-b", "client-1");
    seed_family_with_token(&store, &untouched, &sample_token("other", "family-b"));
    // token-1 was genuinely redeemed before the revocation — its stamp
    // must survive the family kill untouched.
    let redeemed_at = Utc::now();
    assert!(store
        .with_connection(|tx| tx.stamp_refresh_token_consumed_if_live("token-1", redeemed_at))
        .expect("consume"));

    let revoked_at = Utc::now();
    store
        .expire_refresh_token_family("family-a", revoked_at)
        .expect("expire");

    // Rows are kept — the lineage stays auditable — with the family's
    // deadline pulled back to the revocation instant.
    let (redeemed_token, family) = store
        .refresh_token_with_family_by_hash("token-1")
        .expect("query")
        .expect("row present");
    assert_eq!(family.expires_at, revoked_at);
    assert_eq!(redeemed_token.consumed_at, Some(redeemed_at));
    // The live token is stamped at the revocation instant, so nothing in
    // a dead family looks live.
    let (live_token, _) = store
        .refresh_token_with_family_by_hash("token-2")
        .expect("query")
        .expect("row present");
    assert_eq!(live_token.consumed_at, Some(revoked_at));
    // The sibling family is untouched.
    let (other_token, other_family) = store
        .refresh_token_with_family_by_hash("other")
        .expect("query")
        .expect("row present");
    assert_eq!(other_family.expires_at, untouched.expires_at);
    assert_eq!(other_token.consumed_at, None);
}

/// The reclaiming delete is FK-safe and cascades by hand: a family past the
/// cutoff goes with **every** generation under it, so no token row is left
/// pointing at a family that no longer exists (which `PRAGMA foreign_keys = ON`
/// would reject outright, and which would otherwise read as "unknown token" and
/// silently defeat replay detection).
#[test]
fn delete_expired_families_takes_every_generation_with_them() {
    let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
    let mut dead = sample_family("family-dead", "client-1");
    dead.expires_at = Utc::now() - chrono::Duration::days(91);
    seed_family_with_token(&store, &dead, &sample_token("dead-1", "family-dead"));
    store
        .insert_refresh_token(&sample_token("dead-2", "family-dead"))
        .expect("insert a second generation");

    let purged = store
        .with_connection(|tx| {
            tx.delete_refresh_token_families_expired_before(Utc::now() - chrono::Duration::days(90))
        })
        .expect("delete");

    assert_eq!(
        purged, 1,
        "one family removed, counted by family not by token"
    );
    for gone in ["dead-1", "dead-2"] {
        assert!(
            store
                .refresh_token_with_family_by_hash(gone)
                .expect("query")
                .is_none(),
            "{gone} outlived its family",
        );
    }
}

/// The cutoff is a strict `<` on the family's own deadline, so a family that
/// merely *expired* — including one revoked for reuse, whose `expires_at` was
/// pulled back to the revocation instant — stays readable until it ages past
/// the window. This is what keeps the "revocation keeps the lineage auditable"
/// guarantee from being quietly undone by the sweep.
#[test]
fn delete_expired_families_spares_the_recently_dead_and_the_live() {
    let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
    let mut recently_revoked = sample_family("family-revoked", "client-1");
    recently_revoked.expires_at = Utc::now() - chrono::Duration::days(1);
    seed_family_with_token(
        &store,
        &recently_revoked,
        &sample_token("revoked-token", "family-revoked"),
    );
    // `sample_family` deadlines land 90 days out, i.e. comfortably live.
    seed_family_with_token(
        &store,
        &sample_family("family-live", "client-1"),
        &sample_token("live-token", "family-live"),
    );

    let purged = store
        .with_connection(|tx| {
            tx.delete_refresh_token_families_expired_before(Utc::now() - chrono::Duration::days(90))
        })
        .expect("delete");

    assert_eq!(purged, 0);
    for spared in ["revoked-token", "live-token"] {
        assert!(
            store
                .refresh_token_with_family_by_hash(spared)
                .expect("query")
                .is_some(),
            "{spared} was reclaimed early",
        );
    }
}

#[test]
fn expire_for_client_spares_other_clients() {
    let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
    seed_family_with_token(
        &store,
        &sample_family("family-a", "client-1"),
        &sample_token("token-1", "family-a"),
    );
    let untouched = sample_family("family-b", "client-2");
    seed_family_with_token(&store, &untouched, &sample_token("other", "family-b"));

    let revoked_at = Utc::now();
    store
        .with_connection(|tx| tx.expire_refresh_token_families_for_client("client-1", revoked_at))
        .expect("expire");

    let (token, family) = store
        .refresh_token_with_family_by_hash("token-1")
        .expect("query")
        .expect("row present");
    assert_eq!(family.expires_at, revoked_at);
    assert_eq!(token.consumed_at, Some(revoked_at));
    let (other_token, other_family) = store
        .refresh_token_with_family_by_hash("other")
        .expect("query")
        .expect("row present");
    assert_eq!(other_family.expires_at, untouched.expires_at);
    assert_eq!(other_token.consumed_at, None);
}
