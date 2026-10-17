import { HttpClient, HttpClientResponse } from '@effect/platform'
import type { HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Layer } from 'effect'
import { type JSX, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { browserSessionRunner } from '../browser-session.ts'
import { PairPage } from './pair-page.tsx'

/**
 * The pairing page against a stub server: every request goes through the
 * real runner, client and decoders, over a transport that answers like the
 * authorization server does.
 */

const SERVER_ORIGIN = 'https://ruth.relay.example'

const NEXT = '/oauth/authorize?client_id=app&state=s'

/** A request the stub server saw: its path and JSON body. */
interface SeenRequest {
  readonly path: string
  readonly body: unknown
}

type Answer = (request: SeenRequest) => { readonly status: number; readonly body: unknown }

let seen: SeenRequest[] = []
let answer: Answer = () => ({ status: 404, body: {} })

const bodyOf = (request: HttpClientRequest.HttpClientRequest): unknown =>
  request.body._tag === 'Uint8Array'
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : undefined

const stubServer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    const seenRequest: SeenRequest = {
      path: new URL(request.url).pathname,
      body: bodyOf(request),
    }
    seen.push(seenRequest)
    const reply = answer(seenRequest)
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        })
      )
    )
  })
)

/** The start the stub server answers each pairing with, numbered from 1. */
const startedPairing = (attempt: number, interval: number): unknown => ({
  pairingCode: `pairing-code-${attempt}`,
  userCode: `CODE-000${attempt}`,
  browserName: 'Firefox on Linux',
  next: NEXT,
  expiresIn: 300,
  interval,
})

/**
 * A stub server that starts each pairing polling every `interval` seconds,
 * and answers the polls of each with `statuses` in turn, the last one for
 * every poll after.
 */
const serverAnswering =
  (statuses: readonly string[], interval = 0): Answer =>
  (request) => {
    if (request.path === '/oauth/pair/start') {
      const attempt = seen.filter(({ path }) => path === '/oauth/pair/start').length
      return { status: 200, body: startedPairing(attempt, interval) }
    }
    if (request.path === '/oauth/pair/poll') {
      const polls = polled().length
      const status = statuses[Math.min(polls, statuses.length) - 1] ?? 'pending'
      return { status: 200, body: { status } }
    }
    return { status: 404, body: {} }
  }

/** The polls the stub server received. */
const polled = (): readonly SeenRequest[] =>
  seen.filter((request) => request.path === '/oauth/pair/poll')

const goTo = vi.fn<(location: string) => void>()

beforeEach(() => {
  seen = []
  goTo.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const renderPage = (next = NEXT): { readonly user: ReturnType<typeof userEvent.setup> } => {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  render(
    <PairPage
      next={next}
      runAuthed={browserSessionRunner(SERVER_ORIGIN, stubServer)}
      goTo={goTo}
    />,
    { wrapper }
  )
  return { user: userEvent.setup({ delay: null }) }
}

describe('PairPage', () => {
  test('starts a pairing for its next and shows the code, named after the user agent', async () => {
    answer = serverAnswering(['pending'])
    renderPage()

    expect(await screen.findByText('CODE-0001')).toBeDefined()
    expect(screen.getByLabelText<HTMLInputElement>('Name this browser').value).toBe(
      'Firefox on Linux'
    )
    expect(screen.getByText(/approve this code on the device running your server/)).toBeDefined()
    expect(seen[0]).toEqual({ path: '/oauth/pair/start', body: { next: NEXT } })
  })

  test('polls with the name as it stands, and goes on to next once approved', async () => {
    let approve = false
    const pending = serverAnswering(['pending'])
    answer = (request) =>
      request.path === '/oauth/pair/poll' && approve
        ? { status: 200, body: { status: 'approved' } }
        : pending(request)
    const { user } = renderPage()

    const name = await screen.findByLabelText('Name this browser')
    await user.clear(name)
    await user.type(name, 'Kitchen laptop')
    approve = true

    expect(await screen.findByText('Signed in. Taking you back…')).toBeDefined()
    expect(goTo).toHaveBeenCalledExactlyOnceWith(NEXT)
    expect(polled().at(-1)?.body).toEqual({
      pairingCode: 'pairing-code-1',
      browserName: 'Kitchen laptop',
    })
  })

  test('a declined pairing says so, and a new code starts a fresh pairing', async () => {
    answer = serverAnswering(['denied', 'pending'])
    const { user } = renderPage()

    expect(
      await screen.findByText('The request to sign in this browser was declined.')
    ).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Get a new code' }))

    expect(await screen.findByText('CODE-0002')).toBeDefined()
    expect(seen.filter(({ path }) => path === '/oauth/pair/start')).toHaveLength(2)
    expect(goTo).not.toHaveBeenCalled()
  })

  test('an expired or unknown pairing says the code expired', async () => {
    answer = (request) =>
      request.path === '/oauth/pair/poll'
        ? { status: 404, body: { error: 'BrowserPairingNotFound' } }
        : serverAnswering([])(request)
    renderPage()

    expect(await screen.findByText('This code expired before it was approved.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Get a new code' })).toBeDefined()
  })

  test('a next the server refuses starts nothing and says the link is bad', async () => {
    answer = () => ({ status: 400, body: { error: 'BrowserPairingNextNotAllowed' } })
    renderPage('https://evil.example/')

    expect(await screen.findByText(/This sign-in link isn't valid/)).toBeDefined()
    expect(polled()).toEqual([])
  })

  test('slow_down waits longer before the next poll', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    answer = serverAnswering(['slow_down', 'approved'], 5)
    renderPage()
    expect(await screen.findByText('CODE-0001')).toBeDefined()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(polled()).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(polled()).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(polled()).toHaveLength(2)
    expect(goTo).toHaveBeenCalledExactlyOnceWith(NEXT)
  })
})
