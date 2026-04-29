# AGENTS.md — global/

Project-agnostic shared utilities. Should be immediately copy-pastable to an unrelated project.

## Rules

- **No project-specific knowledge** — no FHIR, no Wildflower types, no slice-specific assumptions
- **Minimize dependencies** — generic utilities pull as little as possible
- **Each package is publishable in spirit** even if not actually published — README describes purpose and main exports
- Platform-specific generic utilities live alongside their generic counterparts (e.g., `expo-effect-platform`, `expo-localtunnel`, `react-tundraish`)

## References

- [Effect Patterns Reference](../docs/Effect/Patterns%20Reference.md) — Effect-TS conventions for generic Effect utilities
- [Doc Comments Reference](../docs/Documentation/Doc%20Comments%20Reference.md) — TSDoc on every exported symbol matters most here, since these are the most reusable surfaces