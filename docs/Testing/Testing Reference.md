# Testing Reference

Vitest across all packages. Property-based testing is the default approach.

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
