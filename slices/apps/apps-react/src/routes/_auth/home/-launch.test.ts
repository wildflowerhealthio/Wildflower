import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import type { AppEntry } from '../../../queries.ts'
import type { RunAuthed } from '../../../router-context.ts'
import { launchApp } from './-launch.ts'

// A minimal `AppEntry` — `launchApp` reads only `id`, so the other fields are
// the lightest valid wire shape. (The list response intentionally omits `url`
// — the launch endpoint resolves it per request.)
const app: AppEntry = {
  id: 'pt-browser',
  enabled: true,
  name: 'Patient Browser',
  provenance: 'cloud',
  localOnly: false,
  smart: false,
  requiresTunnel: false,
}

// Some launches need a hidden form to submit to; build one fresh per test
// so action mutations don't leak between cases.
const makeForm = (): HTMLFormElement => document.createElement('form')

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

      await launchApp(
        {
          apiBaseUrl: 'http://127.0.0.1:8080',
          runAuthed: stub.runAuthed,
          pageOrigin: 'tauri://localhost',
          form: makeForm(),
        },
        app
      )

      // The launch rides `runAuthed` (not a raw `fetch`), so the owner bearer
      // is attached the same way the apps-list read and admin writes attach it.
      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0]?.effect).toBeDefined()
    })

    test('does NOT submit the form when apiBaseUrl is set', async () => {
      const form = makeForm()
      const submit = vi.spyOn(form, 'submit').mockImplementation(() => {})

      await launchApp(
        {
          apiBaseUrl: 'http://127.0.0.1:8080',
          runAuthed: makeRunAuthed().runAuthed,
          pageOrigin: 'tauri://localhost',
          form,
        },
        app
      )

      expect(submit).not.toHaveBeenCalled()
    })

    test('logs a typed failure (e.g. a 404 for a just-deleted app) instead of throwing', async () => {
      // A typed error surfaces as a rejected `runAuthed`; the helper catches it
      // so the click handler never sees a throw.
      const stub = makeRunAuthed('reject')

      await expect(
        launchApp(
          {
            apiBaseUrl: 'http://127.0.0.1:8080',
            runAuthed: stub.runAuthed,
            pageOrigin: 'tauri://localhost',
            form: null,
          },
          app
        )
      ).resolves.toBeUndefined()

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('launch failed'),
        expect.any(Error)
      )
    })

    test('does not log on the happy path (the host 204s, the client resolves)', async () => {
      await launchApp(
        {
          apiBaseUrl: 'http://127.0.0.1:8080',
          runAuthed: makeRunAuthed().runAuthed,
          pageOrigin: 'tauri://localhost',
          form: null,
        },
        app
      )

      expect(consoleError).not.toHaveBeenCalled()
    })
  })

  describe('web arm (apiBaseUrl unset)', () => {
    test('submits the hidden form to ${pageOrigin}/apps/{id}, never touching runAuthed', async () => {
      const stub = makeRunAuthed()
      const form = makeForm()
      const submit = vi.spyOn(form, 'submit').mockImplementation(() => {})

      await launchApp(
        {
          apiBaseUrl: undefined,
          runAuthed: stub.runAuthed,
          pageOrigin: 'https://app.example.com',
          form,
        },
        app
      )

      expect(submit).toHaveBeenCalledTimes(1)
      expect(form.action).toBe('https://app.example.com/apps/pt-browser')
      // The web arm rides the front trust boundary — no bearer, no client call.
      expect(stub.calls).toHaveLength(0)
    })

    test('strips a trailing slash on pageOrigin', async () => {
      const form = makeForm()
      const submit = vi.spyOn(form, 'submit').mockImplementation(() => {})

      await launchApp(
        {
          apiBaseUrl: undefined,
          runAuthed: makeRunAuthed().runAuthed,
          pageOrigin: 'https://app.example.com/',
          form,
        },
        app
      )

      expect(submit).toHaveBeenCalledTimes(1)
      expect(form.action).toBe('https://app.example.com/apps/pt-browser')
    })

    test('encodes a path-unsafe id', async () => {
      const form = makeForm()
      const submit = vi.spyOn(form, 'submit').mockImplementation(() => {})

      await launchApp(
        {
          apiBaseUrl: undefined,
          runAuthed: makeRunAuthed().runAuthed,
          pageOrigin: 'https://app.example.com',
          form,
        },
        { ...app, id: 'has spaces/and-slashes' }
      )

      expect(submit).toHaveBeenCalledTimes(1)
      expect(form.action).toBe('https://app.example.com/apps/has%20spaces%2Fand-slashes')
    })

    test('is a no-op when the form ref is null (component not mounted yet)', async () => {
      const stub = makeRunAuthed()

      await launchApp(
        {
          apiBaseUrl: undefined,
          runAuthed: stub.runAuthed,
          pageOrigin: 'https://app.example.com',
          form: null,
        },
        app
      )

      expect(stub.calls).toHaveLength(0)
    })
  })
})
