# Scopes

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers slices/scopes/scopes-rust/src/smart.rs}}
{{#covers slices/scopes/scopes-rust/src/lib.rs}}

A **scope** names a slice of access: `patient/Observation.rs` reads and searches one patient's observations, `system/*.cruds` does anything to any resource, `offline_access` asks for a refresh token. Every list of scopes in this server is a list of these strings: what a client's registration allows, what a request asks for, what a grant, a browser session or a token holds.

**The server never compares scopes by spelling.** It parses each string into a structured scope and asks whether one **covers** another: `patient/*.rs` covers `patient/Observation.r`, and `system/*.cruds` covers both. Whenever a later page says a registration, a grant or a browser session "covers" a request, it means [`allowed_scope_covers`](#item-allowed_scope_covers). Parsing never fails: a string the grammar can't read is kept as an unknown scope that covers only itself.

The scopes live in their own slice, `slices/scopes/scopes-rust`, shared by the server's Rust slices. This page shows the parts the authorization server uses. Three questions come up again and again:

- **Does one scope cover another?** A client's registration, a standing grant and a browser session each answer it for a request ([`allowed_scope_covers`](#item-allowed_scope_covers)).
- **What does a list become, widened by another?** An approval widens a grant, and a client's registration trusted on first use, by what it granted ([`widened_scopes`](#item-widened_scopes)).
- **What may an approval grant?** What the Owner ticked, kept only where the request asked for it and a ceiling allows it ([`grantable_scopes`](#item-grantable_scopes)).

## `wildflowerhealthio_scopes::scope`

The structured model the string-facing functions below parse into.

### `Scope`

{{#item slices/scopes/scopes-rust/src/scope/mod.rs Scope}}

#### `covers`

{{#item slices/scopes/scopes-rust/src/scope/mod.rs Scope::covers}}

### `Grant`

A list of scopes as one value. A token's `scope` claim is read into one, and the scope gates check a caller's authority against it.

{{#item slices/scopes/scopes-rust/src/scope/grant.rs Grant}}

#### `widen`

{{#item slices/scopes/scopes-rust/src/scope/grant.rs Grant::widen tests="tests::widening_replaces_a_narrower_entry_with_the_broader_grant tests::widening_by_an_already_covered_scope_changes_nothing tests::widening_unions_the_interactions_of_one_resource tests::widening_never_merges_a_v1_word_into_a_letter_bag tests::widening_absorbs_across_resources_and_contexts_by_coverage"}}

## `wildflowerhealthio_scopes::smart`

The string-facing entry points, which take and return the `Vec<String>` columns the server stores. The tests here build sets with a [small helper](<Test Fixtures Explanation.md#scopes>).

### `allowed_scope_covers`

{{#item slices/scopes/scopes-rust/src/smart.rs allowed_scope_covers tests="tests::exact_match_grants tests::type_wildcard_covers_specific_type tests::narrower_perms_covered_by_broader_perms tests::context_hierarchy_only_system_covers_downward tests::missing_perm_bit_rejects tests::non_smart_scopes_only_match_exactly tests::v1_word_perms_cover_only_within_the_word_grammar tests::v1_and_v2_perms_cross_cover_letter_over_word_only tests::invalid_perm_segments_reject"}}

### `widened_scopes`

{{#item slices/scopes/scopes-rust/src/smart.rs widened_scopes}}

### `grantable_scopes`

The server calls this through {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::grantable_subset}}, with the ceiling the request allows: for an app's request, what its [client registration](<Client Explanation.md>) permits.

{{#item slices/scopes/scopes-rust/src/smart.rs grantable_scopes tests="tests::grantable_filters_by_requested_and_allowed_coverage tests::grantable_drops_uncovered_approvals tests::grantable_preserves_v1_word_scopes tests::grantable_preserves_write_and_wildcard_words tests::grantable_keeps_distinct_word_and_letter_forms tests::grantable_grants_owner_narrowed_v2_letters tests::grantable_grants_wildcard_requested_narrowed_to_concrete_type tests::grantable_grants_non_canonical_letter_order tests::grantable_drops_unrequested_resource_scopes tests::grantable_bridges_letter_over_word_asymmetrically tests::grantable_known_scopes_match_exactly_not_by_coverage tests::grantable_allowed_clamp_still_applies_under_coverage"}}

### `with_alternate_canonical_forms`

The server mints a token's `scope` claim through this, so the FHIR server, which reads only the letter grammar, honours a grant spelled in words.

{{#item slices/scopes/scopes-rust/src/smart.rs with_alternate_canonical_forms tests="tests::alternates_added_for_v1_word_resource_scopes tests::no_alternate_for_letter_forms_and_non_resource_scopes tests::alternate_expansion_is_idempotent_and_deduplicates_existing_alternates tests::alternates_preserve_order_in_a_typical_smart_grant"}}

## `wildflowerhealthio_scopes`

### `render_scopes`

{{#item slices/scopes/scopes-rust/src/lib.rs render_scopes}}
