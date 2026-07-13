import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import type { AppRegistration } from '../../../queries.ts'
import type { RunAuthed } from '../../../router-context.ts'
import { launchApp, launchHref } from './-launch.ts'

// A minimal uniform registration — `launchApp` / `launchHref` read only `id`.
const app: AppRegistration = {
  id: 'pt-browser',
  enabled: true,
  name: 'Patient Browser',
  kind: 'system',
  localOnly: false,
  smart: false,
  requiresTunnel: false,
}

// The loopback arm runs an Effect through `runAuthed`; the helper only cares
// that it's invoked with *some* effect and that it resolves or rejects. A
// genuine `RunAuthed` stub records its calls into `calls` (the tests assert
// against that) and, by default, resolves — standing in for the host `204`ing
// through the typed client. `mode: 'reject'` exercises the typed-failure path.
//
// `RunAuthed` is generic (`<A, E>(effect) => Promise<A>`): the only value
// assignable to its return `Promise<A>` for *all* `A` is `Promise<never>`
// (reject/throw), so a *resolving* generic `RunAuthed` is inherently
// untypeable — hence the one contained cast (`untypedResolve`) on the resolve
// branch. It doesn't weaken the test: `launchApp` never reads the resolved
// value (it just `await`s), so resolving with `undefined` is faithful.
interface RunAuthedStub {
  readonly runAuthed: RunAuthed
  readonly calls: readonly { readonly effect: unknown }[]
}

// A resolving generic `RunAuthed` can't be expressed without a cast (see above);
// isolate it to this one helper so the rest of the file stays cast-free. This is
// the documented test-file exception to the no-casts rule — it doesn't reduce
// confidence in the test (the resolved value is never read by `launchApp`).
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- resolving generic RunAuthed is inherently untypeable; see block comment above
const untypedResolve: RunAuthed = (() => Promise.resolve(undefined)) as RunAuthed

const makeRunAuthed = (mode: 'resolve' | 'reject' = 'resolve'): RunAuthedStub => {
  const calls: { readonly effect: unknown }[] = []
  const runAuthed: RunAuthed = (effect) => {
    calls.push({ effect })
    return mode === 'reject' ? Promise.reject(new Error('AppNotFound')) : untypedResolve(effect)
  }
  return { runAuthed, calls }
}

// A representative Tauri host origin — its presence (not its value) is the
// launch-arm signal.
const TAURI_API_BASE = 'http://127.0.0.1:8080'

describe('launchHref', () => {
  test('web (apiBaseUrl unset) → a page-relative /apps/{id} the anchor navigates to', () => {
    // On web the page IS the API origin, so a relative path reaches the launch
    // route; the browser (plain click or cmd/ctrl-click) follows it natively.
    expect(launchHref(undefined, 'pt-browser')).toBe('/apps/pt-browser')
  })

  test('Tauri (apiBaseUrl set) → undefined, so the tile is a non-navigating button', () => {
    // No href on Tauri: the loopback arm launches through the authed client and
    // the webview must never navigate.
    expect(launchHref(TAURI_API_BASE, 'pt-browser')).toBeUndefined()
  })

  test('encodes a path-unsafe id', () => {
    expect(launchHref(undefined, 'has spaces/and-slashes')).toBe('/apps/has%20spaces%2Fand-slashes')
  })
})

describe('launchApp', () => {
  let consoleError: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    // The loopback arm logs through `console.error` on a typed failure; spy on
    // it so the assertions can read what was logged and the output stays quiet.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    consoleError.mockRestore()
  })

  describe('loopback / Tauri arm (apiBaseUrl set)', () => {
    test('launches through the authed Effect client (carries the owner bearer)', async () => {
      const stub = makeRunAuthed()

      await launchApp({ apiBaseUrl: TAURI_API_BASE, runAuthed: stub.runAuthed }, app)

      // The launch rides `runAuthed` (not a raw `fetch`), so the owner bearer
      // is attached the same way the apps-list read and admin writes attach it.
      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0]?.effect).toBeDefined()
    })

    test('logs a typed failure (e.g. a 404 for a just-deleted app) instead of throwing', async () => {
      // A typed error surfaces as a rejected `runAuthed`; the helper catches it
      // so the click handler never sees a throw.
      const stub = makeRunAuthed('reject')

      await expect(
        launchApp({ apiBaseUrl: TAURI_API_BASE, runAuthed: stub.runAuthed }, app)
      ).resolves.toBeUndefined()

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('launch failed'),
        expect.any(Error)
      )
    })

    test('does not log on the happy path (the host 204s, the client resolves)', async () => {
      await launchApp({ apiBaseUrl: TAURI_API_BASE, runAuthed: makeRunAuthed().runAuthed }, app)

      expect(consoleError).not.toHaveBeenCalled()
    })
  })

  describe('web arm (apiBaseUrl unset)', () => {
    test('is a no-op — the anchor navigates, so JS never touches runAuthed', async () => {
      const stub = makeRunAuthed()

      await expect(
        launchApp({ apiBaseUrl: undefined, runAuthed: stub.runAuthed }, app)
      ).resolves.toBeUndefined()

      // The web arm rides the anchor navigation (cookie authenticates) — no
      // bearer, no client call.
      expect(stub.calls).toHaveLength(0)
    })
  })
})
