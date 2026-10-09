// TanStack Router's scroll-restoration runs on every navigation and calls
// `window.scrollTo`, which jsdom does not implement — it logs "Not
// implemented: window.scrollTo" through `console.error` on every render that
// settles a route. That behavior is irrelevant to these component tests, so
// this setup file (wired via `test.setupFiles` in `vite.config.ts`) installs a
// no-op stub once per test file, keeping the output focused on real failures.
//
// A plain property assignment is used instead of `vi.spyOn`, so the stub
// survives the `vi.restoreAllMocks()` calls in some suites' `afterEach` hooks
// (which would otherwise restore jsdom's throwing implementation mid-file).

window.scrollTo = (): void => {}
