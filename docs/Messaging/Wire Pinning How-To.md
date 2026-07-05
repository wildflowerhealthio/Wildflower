# Wire Pinning How-To

How to add or change a message that crosses the TS ⇄ Rust bridge boundary while keeping both sides byte-compatible. The canonical example is the gatekeeper bridge: `slices/gatekeeper/gatekeeper-core/src/bridge.ts` (TS) mirrored by `slices/gatekeeper/gatekeeper-rust/src/bridge.rs` (Rust). For why the bridge works the way it does, see the [Bridge Explanation](./Bridge%20Explanation.md).

## 1. Declare the TS schema

In the slice's `<name>-core/src/bridge.ts`, add a `Schema.parseJson(Schema.TaggedStruct('YourTag', { ... }))` entry with camelCase field names, and register it in the slice's `Bridge.make` record for the right direction. Document the exact wire string in the TSDoc (`Wire: {"_tag":"YourTag","someField":"…"}`).

Before choosing the tag literal, confirm it is unused across every listener on the shared channel — the checklist is in the [effect-messaging-tauri README](../../global/effect-messaging/effect-messaging-tauri/README.md). Tag collisions dispatch silently on both listeners; no test catches them.

## 2. Mirror the Rust type

In the slice's `<name>-rust/src/bridge.rs`, mirror the shape as a serde enum:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum YourSliceHostToWeb {
    #[serde(rename_all = "camelCase")]
    YourTag { some_field: Option<String> },
}
```

Put the pin in writing: the type-level doc comment states that the payload shape is pinned by the TS schema, and each variant's doc comment shows the exact wire string(s), including the `null` form for `Option` fields.

## 3. Write the golden tests

Golden tests assert the exact serialized string, so any serde-attribute drift is a test failure rather than a silent cross-language protocol break:

```rust
#[test]
fn your_tag_serializes_to_pinned_wire_format() {
    let message = YourSliceHostToWeb::YourTag { some_field: None };
    assert_eq!(
        serde_json::to_string(&message).expect("serialize"),
        r#"{"_tag":"YourTag","someField":null}"#
    );
}
```

Cover every variant, and every optionality form of each variant (`Some`/`None` both have pinned shapes — empty-vs-absent mismatches have broken whole-response decodes before; see [Review Standards](../Agents/Review%20Standards%20Reference.md) rule 3). Add a proptest round-trip (`serialize → deserialize → assert_eq`) for variants with payloads, and a deserialize test for messages the Rust side receives.

The TS side needs no separate golden test: the schema _is_ the validator — inbound payloads decode against it, and the golden strings on the Rust side are asserted against the same shapes the TSDoc documents. Do not hand-copy a constants table between the sides; the golden test is the drift guard.

## 4. Check the contract symmetrically

- Optionality must match between sides: a field the host can omit or `null` must decode as absent/`null` in TS, and vice versa.
- If the message is host-emitted on Tauri, the host must only send after `__Ready` (see the [Bridge Explanation](./Bridge%20Explanation.md)).
- Never put secrets in a bridge payload — use a contentless notify plus an out-of-band capability-gated fetch (the `AuthTokenIssued` pattern).

## See also

- [Bridge Explanation](./Bridge%20Explanation.md) — layering, ordering, handshake, threat model
- [OpenAPI Spec Drift How-To](../Effect/OpenAPI%20Spec%20Drift%20How-To.md) — the equivalent drift guard for HTTP APIs
- [Review Standards Reference](../Agents/Review%20Standards%20Reference.md) — wire-contract and can-fail test rules
