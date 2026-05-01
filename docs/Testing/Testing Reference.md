# Testing Reference

Vitest across most packages; Expo packages run Jest with `jest-expo`. Property-based testing is the default approach.

## Test Runners

| Runner                  | Where it runs                                                                                        | How to invoke                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Vitest (via Vite+)      | Every non-Expo package                                                                               | `vp test` (Vitest projects mode wired in root `vite.config.ts`; works from the root or any package directory) |
| Jest (with `jest-expo`) | `apps/wildflower`, `global/expo-effect-platform`, `global/expo-localtunnel`, `global/expo-tundraish` | `vp run jest` (in a package), `vp run jest` (root, fans out with `--concurrency-limit 1`)                     |

`vp run test-all` runs Vitest then Jest for a complete pass; `vp run ready` includes it.

## When to Use Each Approach

| Approach                                                   | Use When                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| [Property testing](./Property%20Testing%20Reference.md)    | Arbitraries, verified mocks, MECE assertions, algebraic properties |
| [Unit testing](./Unit%20Testing%20How-To.md)               | Testing pure domain logic, schemas, helpers, and Effect-TS code    |
| [React testing](./React%20Testing%20Reference.md)          | Testing React components, hooks, and UI behavior                   |
| [Integration testing](./Integration%20Testing%20How-To.md) | Testing code that calls external HTTP APIs (FHIR, OAuth, etc.)     |

## Key Principles

- **Property-based first**: Default to `fast-check` properties with `Arbitrary.make(Schema)` for data generation. Use example-based tests only for regressions and documentation.
- **MECE structure**: Tests should be Mutually Exclusive and Completely Exhaustive.
- **Concise and high-value**: A single powerful property test beats ten trivial example tests.
- **Colocate tests**: Place `*.test.ts` files next to the source files they test.
