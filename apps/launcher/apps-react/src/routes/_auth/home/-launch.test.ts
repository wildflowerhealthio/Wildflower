import { Effect, Either } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { AppRegistration } from '../../../queries.ts'
import type { RunAuthed } from '../../../router-context.ts'
import { launchBannerError } from './-launch-error.ts'
import { launchApp, type LaunchContext } from './-launch.ts'

// A minimal uniform registration — `launchApp` reads only `id`.
const app: AppRegistration = {
  id: 'growth-chart',
  onHomescreen: true,
  name: 'Growth Chart',
  url: 'https://example.com/launch',
  isSmart: false,
}

interface RunAuthedStub {
  readonly runAuthed: RunAuthed
  readonly calls: readonly { readonly effect: unknown }[]
}

// A resolving generic `RunAuthed` can't be expressed without a cast: its return
// `Promise<A>` is inhabited for *all* `A` only by `Promise<never>` (reject). Isolate
// the cast here so the rest of the file stays cast-free — the documented test-file
// exception. `value` stands in for what `LaunchApp` decodes: the `{ url }` of
// the launch's `200`.
const untypedResolve = (value: { readonly url: string }): RunAuthed =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- resolving generic RunAuthed is inherently untypeable
  (() => Promise.resolve(value)) as RunAuthed

const resolvingRunAuthed = (value: { readonly url: string }): RunAuthedStub => {
  const calls: { readonly effect: unknown }[] = []
  const resolve = untypedResolve(value)
  return { calls, runAuthed: (effect) => (calls.push({ effect }), resolve(effect)) }
}

const rejectingRunAuthed = (error: unknown): RunAuthedStub => {
  const calls: { readonly effect: unknown }[] = []
  return { calls, runAuthed: (effect) => (calls.push({ effect }), Promise.reject(error)) }
}

describe('launchApp', () => {
  test('launches through the authed client and navigates to the launch URL it answers with', async () => {
    const stub = resolvingRunAuthed({ url: 'https://medications.demo.example.com/' })
    const nav = recordingNavigate()

    const result = await launchApp({ runAuthed: stub.runAuthed, navigate: nav.navigate }, app.id)

    // The launch rides `runAuthed` (not a raw `fetch`), so the owner bearer is
    // attached.
    expect(result).toEqual(Either.void)
    expect(stub.calls).toHaveLength(1)
    expect(nav.seen).toEqual(['https://medications.demo.example.com/'])
  })

  test('encodes a 403 InsufficientScope so the banner can name the missing scopes', async () => {
    // `LaunchApp` declares the `403`, so it decodes to the shared body; the encoded
    // param round-trips back to that body (which the app's ambient renderer turns
    // into the AuthorizationFailure surface).
    const body = { error: 'InsufficientScope', missingScopes: ['wildflower/launch'] }
    const nav = recordingNavigate()

    const result = await launchApp(ctxRejecting(body, nav), app.id)

    expect(launchBannerError(Either.isLeft(result) ? result.left : undefined)).toEqual(body)
    expect(nav.seen).toEqual([])
  })

  test('encodes a declared 404 as the no-longer-available message', async () => {
    const result = await launchApp(
      ctxRejecting({ error: 'AppNotFound', id: app.id }, recordingNavigate()),
      app.id
    )

    expect(launchBannerError(Either.isLeft(result) ? result.left : undefined)).toBe(
      'That app is no longer available.'
    )
  })

  test('encodes an unrecognised failure as the generic launch message', async () => {
    const result = await launchApp(ctxRejecting(new Error('boom'), recordingNavigate()), app.id)

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

    const result = await launchApp(ctxRejecting(fiberFailure, recordingNavigate()), app.id)

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
