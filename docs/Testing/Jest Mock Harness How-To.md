# Jest Mock Harness How-To

Pattern for sharing mock state between a `jest.mock(...)` factory and the test that needs to read or mutate that state. Used by every `-expo` slice that splits its host-receiver tests across multiple files (one harness, multiple suites mocking the same modules against it).

## Why the `mock` prefix

Each consumer calls `jest.mock(path, mockBuildSomethingFactory)`. Jest's babel-plugin hoists `jest.mock(...)` above the imports — referencing an imported binding inside the factory only works if the binding name starts with `mock` (jest's escape-hatch from its temporal-dead-zone check). That's why every factory export in a mocks file should be named `mockBuild*` (or another `mock`-prefixed identifier).

## Why `globalThis`-keyed state

The factories run during ESM-import hoisting — before any module-top `const`/`let`/`var` assignment — so a plain top-level reference inside the factory would still be in TDZ. `globalThis` is initialised before any user code runs, so the shared harness object lives there and the module-top `harness` const just reads it.

Type the global once with `declare global` so the cast falls out:

```typescript
declare global {
  // eslint-disable-next-line no-var
  var __mockSliceHarness: MockHarness | undefined
}

const harness: MockHarness = (() => {
  const existing = globalThis.__mockSliceHarness
  if (existing !== undefined) return existing
  const fresh = freshHarness()
  globalThis.__mockSliceHarness = fresh
  return fresh
})()
```

Use a unique global-property name per slice (`__mockAppsExpoHarness`, `__mockCollectorExpoHarness`, etc.) so two harnesses don't collide if both are loaded under the same Jest process.

## Reset between tests

Tests share the module-level harness object, so per-test mutable fields need a `resetHarness()` helper called from each suite's `beforeEach`:

```typescript
const resetHarness = (): void => {
  harness.lastHandlers = null
  harness.sentMessages = []
}
```

## Worked examples

- `slices/apps/apps-expo/src/__test-support__/host-receiver-test-mocks.ts`
- `slices/collector/collector-expo/src/__test-support__/host-provider-test-mocks.ts`
