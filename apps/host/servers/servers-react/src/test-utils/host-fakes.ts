import { HttpClient, HttpClientError, HttpClientResponse } from '@effect/platform'
import type { TauriInvoke } from '@wildflowerhealthio/servers-core-js'
import { type Context, Effect, Layer } from 'effect'

import type { BaseUnderTestProps } from './base-under-test.tsx'

/** One invoke the fake host saw. */
interface SeenInvoke {
  readonly command: string
  readonly args: Readonly<Record<string, unknown>> | undefined
}

/** A fake host and the invokes it saw. */
interface FakeHost {
  readonly invoke: Context.Tag.Service<TauriInvoke>
  readonly seen: SeenInvoke[]
}

/**
 * A host answering each command from `answers`, rejecting any other, and
 * recording every invoke.
 */
const fakeHost = (answers: Readonly<Record<string, () => Promise<unknown>>>): FakeHost => {
  const seen: SeenInvoke[] = []
  return {
    seen,
    invoke: (command, args) => {
      seen.push({ command, args })
      const answer = answers[command]
      return answer === undefined
        ? Promise.reject(new Error(`unexpected command ${command}`))
        : answer()
    },
  }
}

/** The answers every host gives that a test doesn't change. */
const steadyAnswers = {
  'plugin:background-service|configure_recovery': () => Promise.resolve(null),
} as const

/**
 * A host whose notification permission reads `permission`, whose version is
 * `version`, and whose `servers_list` answers `servers`.
 */
const hostWith = ({
  permission = true,
  version = '0.4.0',
  servers = () => Promise.resolve([]),
  answers = {},
}: {
  readonly permission?: boolean | null
  readonly version?: string
  readonly servers?: () => Promise<unknown>
  readonly answers?: Readonly<Record<string, () => Promise<unknown>>>
} = {}): FakeHost =>
  fakeHost({
    ...steadyAnswers,
    'plugin:notification|is_permission_granted': () => Promise.resolve(permission),
    'plugin:app|version': () => Promise.resolve(version),
    servers_list: servers,
    ...answers,
  })

/** Host events a test emits, and the listeners the base has up. */
interface FakeEvents {
  readonly listen: BaseUnderTestProps['listen']
  /** Deliver `payload` to every listener of `event`. */
  readonly emit: (event: string, payload: unknown) => void
}

/** Host events with no listener yet, delivered as a test emits them. */
const fakeEvents = (): FakeEvents => {
  const listeners = new Set<{
    readonly event: string
    readonly handler: (event: { readonly payload: unknown }) => void
  }>()
  return {
    listen: (event, handler) => {
      const listener = { event, handler }
      listeners.add(listener)
      return Promise.resolve(() => {
        listeners.delete(listener)
      })
    },
    emit: (event, payload) => {
      for (const listener of listeners) {
        if (listener.event === event) listener.handler({ payload })
      }
    },
  }
}

/** Notification taps a test makes, and the listeners the base has up. */
interface FakeTaps {
  readonly listen: BaseUnderTestProps['listenToNotificationTaps']
  /** Deliver `tap` to every listener. */
  readonly tap: (tap: unknown) => void
}

/** Notification taps with no listener yet, delivered as a test makes them. */
const fakeTaps = (): FakeTaps => {
  const handlers = new Set<(tap: unknown) => void>()
  return {
    listen: (handler) => {
      handlers.add(handler)
      return Promise.resolve(() => {
        handlers.delete(handler)
      })
    },
    tap: (tap) => {
      for (const handler of handlers) handler(tap)
    },
  }
}

/** A stub HTTP client answering the base's `/health` reads, and the URLs it was asked for. */
interface FakeHealth {
  readonly layer: Layer.Layer<HttpClient.HttpClient>
  readonly urls: readonly string[]
}

/**
 * A client answering every request with `answer`'s response; an `answer`
 * that throws is a request that never reached a server, failing as
 * `FetchHttpClient` fails one.
 */
const fakeHealth = (answer: () => Response): FakeHealth => {
  const urls: string[] = []
  return {
    urls,
    layer: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        urls.push(request.url)
        return Effect.try({
          try: () => HttpClientResponse.fromWeb(request, answer()),
          catch: (cause) =>
            new HttpClientError.RequestError({ request, reason: 'Transport', cause }),
        })
      })
    ),
  }
}

export {
  type FakeEvents,
  type FakeHealth,
  type FakeHost,
  type FakeTaps,
  type SeenInvoke,
  fakeEvents,
  fakeHealth,
  fakeHost,
  fakeTaps,
  hostWith,
  steadyAnswers,
}
