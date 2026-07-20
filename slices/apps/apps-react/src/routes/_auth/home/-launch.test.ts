import { HttpClientError, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Effect, Either } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { AppRegistration } from '../../../queries.ts'
import type { RunAuthed } from '../../../router-context.ts'
import { launchBannerError } from './-launch-error.ts'
import { launchApp, launchHref } from './-launch.ts'

// A minimal uniform registration — `launchApp` / `launchHref` read only `id`.
const app: AppRegistration = {
  id: 'pt-browser',
  onHomescreen: true,
  name: 'Patient Browser',
  kind: 'system',
  localOnly: false,
  isSmart: false,
  requiresTunnel: false,
}

interface RunAuthedStub {
  readonly runAuthed: RunAuthed
  readonly calls: readonly { readonly effect: unknown }[]
}

// A resolving generic `RunAuthed` can't be expressed without a cast: its return
// `Promise<A>` is inhabited for *all* `A` only by `Promise<never>` (reject). Isolate
// the cast here so the rest of the file stays cast-free — the documented test-file
// exception; `launchApp` never reads the resolved value, so this is faithful.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- resolving generic RunAuthed is inherently untypeable
const untypedResolve: RunAuthed = (() => Promise.resolve(undefined)) as RunAuthed

const resolvingRunAuthed = (): RunAuthedStub => {
  const calls: { readonly effect: unknown }[] = []
  return { calls, runAuthed: (effect) => (calls.push({ effect }), untypedResolve(effect)) }
}

const rejectingRunAuthed = (error: unknown): RunAuthedStub => {
  const calls: { readonly effect: unknown }[] = []
  return { calls, runAuthed: (effect) => (calls.push({ effect }), Promise.reject(error)) }
}

/** A `ResponseError` at `status` — the shape an *undeclared* launch status (`403` /
 * `503`) reaches the typed client as. */
const responseError = (status: number): HttpClientError.ResponseError => {
  const request = HttpClientRequest.get('/apps/pt-browser')
  return new HttpClientError.ResponseError({
    request,
    response: HttpClientResponse.fromWeb(request, new Response(null, { status })),
    reason: 'StatusCode',
  })
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
  describe('loopback / Tauri arm (apiBaseUrl set)', () => {
    test('launches through the authed Effect client and resolves null on success', async () => {
      const stub = resolvingRunAuthed()

      const param = await launchApp({ apiBaseUrl: TAURI_API_BASE, runAuthed: stub.runAuthed }, app)

      // Success is `null` (no banner); the launch rides `runAuthed` (not a raw
      // `fetch`), so the owner bearer is attached like the apps-list read.
      expect(Either.isRight(param)).toBe(true)
      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0]?.effect).toBeDefined()
    })

    test('encodes a 403 InsufficientScope so the banner can name the missing scopes', async () => {
      // `LaunchApp` declares the `403`, so it decodes to the shared body; the encoded
      // param round-trips back to that body (which the app's ambient renderer turns
      // into the AuthorizationFailure surface).
      const body = { error: 'InsufficientScope', missingScopes: ['wildflower/launch'] }
      const stub = rejectingRunAuthed(body)

      const param = await launchApp({ apiBaseUrl: TAURI_API_BASE, runAuthed: stub.runAuthed }, app)

      expect(launchBannerError(Either.isLeft(param) ? param.left : undefined)).toEqual(body)
    })

    test('encodes a 503 as a reachability message', async () => {
      const stub = rejectingRunAuthed(responseError(503))

      const param = await launchApp({ apiBaseUrl: TAURI_API_BASE, runAuthed: stub.runAuthed }, app)

      expect(launchBannerError(Either.isLeft(param) ? param.left : undefined)).toContain('reached')
    })

    test('encodes an unrecognised failure as the generic launch message', async () => {
      const stub = rejectingRunAuthed(new Error('boom'))

      const param = await launchApp({ apiBaseUrl: TAURI_API_BASE, runAuthed: stub.runAuthed }, app)

      expect(launchBannerError(Either.isLeft(param) ? param.left : undefined)).toBe(
        'That app couldn’t be launched.'
      )
    })

    test('unwraps a FiberFailure before classifying', async () => {
      // `runAuthed` rejects with a `FiberFailure` (what `Effect.runPromise` throws),
      // so the body must be read from the wrapped value, not the wrapper.
      const body = { error: 'InsufficientScope', missingScopes: ['wildflower/launch'] }
      const fiberFailure = await Effect.runPromise(Effect.fail(body)).then(
        () => null,
        (rejection: unknown) => rejection
      )
      const stub = rejectingRunAuthed(fiberFailure)

      const param = await launchApp({ apiBaseUrl: TAURI_API_BASE, runAuthed: stub.runAuthed }, app)

      expect(launchBannerError(Either.isLeft(param) ? param.left : undefined)).toEqual(body)
    })
  })

  describe('web arm (apiBaseUrl unset)', () => {
    test('is a no-op — the anchor navigates, so JS never touches runAuthed', async () => {
      const stub = resolvingRunAuthed()

      const param = await launchApp({ apiBaseUrl: undefined, runAuthed: stub.runAuthed }, app)

      // The web arm rides the anchor navigation (cookie authenticates) — no bearer,
      // no client call, and no banner to raise from JS.
      expect(Either.isRight(param)).toBe(true)
      expect(stub.calls).toHaveLength(0)
    })
  })
})
