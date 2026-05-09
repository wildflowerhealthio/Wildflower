# AGENTS.md — slices/

Vertical product slices. Each slice owns a feature end-to-end (HTTP API, store, UI adapters) and is layered into a pure core plus optional platform adapters.

## Slice Layout

Every slice follows the same naming structure:

```text
slices/<name>/
├── <name>-core            # Pure logic: schemas, HttpApi definitions, business rules
├── <name>-web             # Browser adapter (optional)
├── <name>-node            # Node.js adapter (optional)
├── <name>-react-native    # React Native adapter (optional)
└── <name>-expo            # Expo-specific adapter (optional)
```

Current slices: `apps`, `collector`, `emr`, `gatekeeper`, `navigation`, `store`, `telemetry`.

## Rules

- **`<name>-core` is the pure layer** — no DOM, no Node `fs`, no Expo APIs, no platform-specific imports
- **Platform adapters depend on `-core`, never the reverse**
- **Slices should not depend on other slices** unless the dependency is intrinsic to the feature (document why if you do)
- **Compose `HttpApi` groups across slices via the phantom-id bridge pattern** — see [HttpApi Composition How-To](../docs/Effect/HttpApi%20Composition%20How-To.md)
- **Don't use `topLevel: true` on multiple `HttpApiGroup`s under the same `HttpApi`** — name collision in the generated client. See [HttpApi Composition How-To](../docs/Effect/HttpApi%20Composition%20How-To.md).

## References

- [HttpApi Composition How-To](../docs/Effect/HttpApi%20Composition%20How-To.md) — Phantom-id bridge, `*ApiHandlersFor<ParentId>()`, `topLevel` collision
- [Effect Patterns Reference](../docs/Effect/Patterns%20Reference.md) — Tag/Layer wiring used inside slice cores
- [Learnings Inbox](../docs/Agents/Learnings%20Inbox.md) — Slice-specific LiveStore/vp-pack gotchas not yet promoted
