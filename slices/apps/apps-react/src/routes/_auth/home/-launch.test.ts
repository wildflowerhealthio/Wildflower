import { HttpClientError, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Effect, Either } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { AppRegistration } from '../../../queries.ts'
import type { RunAuthed } from '../../../router-context.ts'
import { launchBannerError } from './-launch-error.ts'
import { launchApp, type LaunchContext } from './-launch.ts'

// A minimal uniform registration — `launchApp` reads only `id`.
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
// exception. `value` stands in for what `LaunchApp` decodes: `undefined` for the
// host's `204`, `{ url }` for a forwarded launch's `200`.
const untypedResolve = (value: { readonly url: string } | undefined): RunAuthed =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- resolving generic RunAuthed is inherently untypeable
  (() => Promise.resolve(value)) as RunAuthed

const resolvingRunAuthed = (value?: { readonly url: string }): RunAuthedStub => {
  const calls: { readonly effect: unknown }[] = []
  const resolve = untypedResolve(value)
  return { calls, runAuthed: (effect) => (calls.push({ effect }), resolve(effect)) }
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

describe('launchApp', () => {
  test('launches through the authed client and stays put when the host opened the app', async () => {
    const stub = resolvingRunAuthed()
    const nav = recordingNavigate()

    const result = await launchApp({ runAuthed: stub.runAuthed, navigate: nav.navigate }, app)

    // The launch rides `runAuthed` (not a raw `fetch`), so the owner bearer is
    // attached; a `204` means the host opened the app, so the tab doesn't move.
    expect(Either.isRight(result)).toBe(true)
    expect(stub.calls).toHaveLength(1)
    expect(nav.seen).toEqual([])
  })

  test('navigates to the launch URL a forwarded launch answers with', async () => {
    const stub = resolvingRunAuthed({ url: 'https://patient-browser.demo.example.com/' })
    const nav = recordingNavigate()

    const result = await launchApp({ runAuthed: stub.runAuthed, navigate: nav.navigate }, app)

    expect(Either.isRight(result)).toBe(true)
    expect(nav.seen).toEqual(['https://patient-browser.demo.example.com/'])
  })

  test('encodes a 403 InsufficientScope so the banner can name the missing scopes', async () => {
    // `LaunchApp` declares the `403`, so it decodes to the shared body; the encoded
    // param round-trips back to that body (which the app's ambient renderer turns
    // into the AuthorizationFailure surface).
    const body = { error: 'InsufficientScope', missingScopes: ['wildflower/launch'] }
    const nav = recordingNavigate()

    const result = await launchApp(ctxRejecting(body, nav), app)

    expect(launchBannerError(Either.isLeft(result) ? result.left : undefined)).toEqual(body)
    expect(nav.seen).toEqual([])
  })

  test('encodes a 503 as a reachability message', async () => {
    const result = await launchApp(ctxRejecting(responseError(503), recordingNavigate()), app)

    expect(launchBannerError(Either.isLeft(result) ? result.left : undefined)).toContain('reached')
  })

  test('encodes an unrecognised failure as the generic launch message', async () => {
    const result = await launchApp(ctxRejecting(new Error('boom'), recordingNavigate()), app)

    expect(launchBannerError(Either.isLeft(result) ? result.left : undefined)).toBe(
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

    const result = await launchApp(ctxRejecting(fiberFailure, recordingNavigate()), app)

    expect(launchBannerError(Either.isLeft(result) ? result.left : undefined)).toEqual(body)
  })
})

// Helpers

/** A `navigate` stub that keeps every URL it was asked to go to. */
const recordingNavigate = (): {
  readonly navigate: (url: string) => void
  readonly seen: string[]
} => {
  const seen: string[] = []
  return {
    seen,
    navigate: (url) => {
      seen.push(url)
    },
  }
}

/** A launch context whose `runAuthed` rejects with `error`. */
const ctxRejecting = (
  error: unknown,
  nav: ReturnType<typeof recordingNavigate>
): LaunchContext => ({ runAuthed: rejectingRunAuthed(error).runAuthed, navigate: nav.navigate })
