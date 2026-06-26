# AGENTS.md — apps/

Apps compose slice packages. They handle runtime wiring, routing, user interaction, and platform-specific concerns.

## Rules

- No business logic (belongs in `slices/<name>/<name>-core`)
- Always go through slice-core interfaces and APIs — don't reach into a slice's internals from an app
- Use `slices/<name>/<name>-{web,node}` adapters when you need a platform-specific implementation; never re-implement an adapter in an app

## References

- [Architecture / slice layering](../slices/AGENTS.md) — How slices are layered
- [Effect Patterns Reference](../docs/Effect/Patterns%20Reference.md) — Layer composition and Tag wiring
