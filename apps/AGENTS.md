# AGENTS.md — apps/

Apps compose slice packages. They handle runtime wiring, routing, user interaction, and platform-specific concerns.

## Rules

- No business logic (belongs in `slices/<name>/<name>-core`)
- Always go through slice-core interfaces and APIs — don't reach into a slice's internals from an app
- Use `slices/<name>/<name>-{web,node}` adapters when you need a platform-specific implementation; never re-implement an adapter in an app

## Dev-server ports

The first-party apps that get a debug-only "(Dev)" homescreen tile pin their
vite dev server to a port from `slices/apps/dev-app-ports.json`, which
`apps-rust/src/dev_seed.rs` embeds to seed the matching row. `devAppServer(id)`
in the root [`vite.config.base.ts`](../vite.config.base.ts) is the **only**
TypeScript reader of that file — spread it into `server` (or `preview`) instead
of parsing the JSON again:

```ts
import base, { devAppServer } from '../../vite.config.base.ts'

export default defineConfig({
  ...base,
  server: devAppServer('medications-app-dev'),
})
```

The helper narrows `id` to the file's own keys, so a new app gets its port by
adding a row to the JSON (and to `dev_seed.rs`), not by hand-rolling a reader.

## References

- [Architecture / slice layering](../slices/AGENTS.md) — How slices are layered
- [Effect Patterns Reference](../docs/Effect/Patterns%20Reference.md) — Layer composition and Tag wiring
