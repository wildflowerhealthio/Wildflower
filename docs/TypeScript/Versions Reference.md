# TypeScript Versions Reference

The workspace installs two TypeScripts from the catalog in [pnpm-workspace.yaml](../../pnpm-workspace.yaml):

| Catalog entry  | Version                        | What it is                                                                        |
| -------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| `typescript`   | `5.9.3`                        | The JavaScript compiler, with the JS compiler API (`import ts from 'typescript'`) |
| `typescript-7` | `npm:typescript@7.0.2` (alias) | The native (Go) compiler. Its npm package ships a `tsc` binary and no JS API      |

## Which tool uses which

| Tool                                                                             | TypeScript                      | Why                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp check` / `vp lint` type-aware rules and typecheck                            | 7, bundled in `oxlint-tsgolint` | tsgolint compiles TypeScript 7 into its own binary and reads neither package. Its version moves with vite-plus.                                                                                             |
| `.d.ts` emit in `vp pack` (`dts: tsgoDts`)                                       | 7 (`typescript-7`)              | `tsgoDts` in [vite.config.base.ts](../../vite.config.base.ts) hands the dts generator the `typescript-7` binary. The generator's own lookup checks only bare `typescript` and `@typescript/native-preview`. |
| `tsc` in app `build` scripts (`tsc && vp build`)                                 | 7 (`node_modules/.bin/tsc`)     | Type-check only (`noEmit`). About 5× faster than 5.9 on these apps.                                                                                                                                         |
| `lint:comments` (ESLint with `typescript-eslint`, `tsdoc/syntax`)                | 5 (`typescript`)                | The parser calls the JS compiler API. `typescript-eslint` peers on `<6.1.0`.                                                                                                                                |
| ES5 lowering in [fhir-sync-pebble/pkjs](../../apps/fhir-sync-pebble/pkjs/es5.ts) | 5 (`typescript`)                | Calls `ts.transpileModule` with `target: ES5`. TypeScript 7 has no ES5 target, and neither has rolldown/oxc.                                                                                                |
| Editor tsserver and `@effect/language-service`                                   | 5 (`typescript`)                | The language-service plugin loads into tsserver through the JS API. Point the editor at the workspace's `node_modules/typescript`.                                                                          |

## How the two copies are laid out

- `node_modules/typescript` is 5.9.3, so every `import 'typescript'` and every `typescript` peer resolves to 5.x.
- `node_modules/typescript-7` is 7.0.2. Nothing imports it; `tsgoDts` resolves its binary by path.
- `node_modules/.bin/tsc` is TypeScript 7. Both packages are named `typescript` and ship a `tsc` bin; when two packages of the same name ship one bin, pnpm links the higher version.
- Every package that declares `typescript-7` also declares `typescript`. pnpm can satisfy a `typescript` peer with the aliased 7.0.2 when it is the only `typescript` a package declares, which would put TypeScript 7 under `typescript-eslint` and split peer variants.

## Updating

- Dependabot ignores `typescript` majors ([.github/dependabot.yml](../../.github/dependabot.yml)), so bare `typescript` stays on 5.x until the JS-API tools above support something newer.
- `typescript-7` takes minor and patch updates. The global `pnpm install -g typescript@…` pins in the bootstrap scripts follow it (see [Bumping vite-plus How-To](../Dependencies/Bumping%20vite-plus%20How-To.md)).
- After moving either entry, run `vp run pack` and compare a few packages' `dist/*.d.ts` against the previous build.

## See Also

- [TypeScript CI Build Cache Explanation](./CI%20Build%20Cache%20Explanation.md) — the `vp run pack` cache
- [Version Override Explanation](../Dependencies/Version%20Override%20Explanation.md) — peer variants and the hoisted root slot
