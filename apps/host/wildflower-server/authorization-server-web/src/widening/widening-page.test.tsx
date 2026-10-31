import { HttpClient, HttpClientResponse } from '@effect/platform'
import type { HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Layer, Option } from 'effect'
import { type JSX, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { browserSessionRunner } from '../browser-session.ts'
import { WideningPage } from './widening-page.tsx'

/**
 * The widening's page against a stub server: every request goes through the
 * real runner, client and decoders, over a transport that answers like the
 * authorization server does, so the tests see exactly what the page reads and
 * sends.
 */

const SERVER_ORIGIN = 'https://ruth.relay.example'

/** A request the stub server saw: its method, path and JSON body. */
interface SeenRequest {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

/** How the stub server answers one request: its status and JSON body. */
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
      method: request.method,
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

/** The pending widening `widen-1`, read by a browser lacking `missingApprovalScopes`. */
const wideningConsent = (missingApprovalScopes: readonly string[] = []): unknown => ({
  id: 'widen-1',
  browserName: 'Firefox on Linux',
  clientId: 'wildflower-strength',
  clientName: 'Wildflower Strength',
  requestedScopes: ['wildflower/Apps.r'],
  startingScopes: ['wildflower/Apps.r'],
  missingApprovalScopes,
})

/** The `404` a widening that is no longer pending gets. */
const NOT_FOUND = { status: 404, body: { error: 'SessionWideningNotFound', id: 'widen-1' } }

/** A stub server holding the widening `widen-1`, deciding it with `decision`. */
const serverHolding =
  (decision: { readonly status: number; readonly body: unknown }): Answer =>
  (request) => {
    if (request.method === 'GET' && request.path === '/authorization/session-widenings/widen-1') {
      return { status: 200, body: wideningConsent() }
    }
    if (request.path.startsWith('/authorization/session-widenings/widen-1/')) return decision
    return { status: 404, body: {} }
  }

const goBack = vi.fn<() => void>()

beforeEach(() => {
  seen = []
  goBack.mockReset()
})

afterEach(() => {
  cleanup()
})

const renderPage = (
  goBackOnceDecided: Option.Option<() => void> = Option.none()
): { readonly user: ReturnType<typeof userEvent.setup> } => {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  render(
    <WideningPage
      wideningId="widen-1"
      runAuthed={browserSessionRunner(SERVER_ORIGIN, stubServer)}
      goBackOnceDecided={goBackOnceDecided}
    />,
    { wrapper }
  )
  return { user: userEvent.setup({ delay: null }) }
}

/** The `POST`s the stub server received, with their bodies. */
const posted = (): readonly { readonly path: string; readonly body: unknown }[] =>
  seen.filter((request) => request.method === 'POST').map(({ path, body }) => ({ path, body }))

describe('WideningPage', () => {
  test('approving sends what is left ticked and says the browser can do more', async () => {
    answer = serverHolding({ status: 200, body: { status: 'approved' } })
    const { user } = renderPage()

    await user.click(await screen.findByRole('button', { name: 'Approve' }))

    expect(
      await screen.findByText('Approved. The browser can do more once it goes on.')
    ).toBeDefined()
    expect(posted()).toEqual([
      {
        path: '/authorization/session-widenings/widen-1/approve',
        body: { approvedScopes: ['wildflower/Apps.r'] },
      },
    ])
  })

  test('in then=back mode a decline says so and steps back out', async () => {
    answer = serverHolding({ status: 200, body: { status: 'denied' } })
    const { user } = renderPage(Option.some(goBack))

    await user.click(await screen.findByRole('button', { name: 'Decline' }))

    expect(await screen.findByText('Declined. You can close this.')).toBeDefined()
    expect(goBack).toHaveBeenCalledTimes(1)
    expect(posted().map(({ path }) => path)).toEqual([
      '/authorization/session-widenings/widen-1/deny',
    ])
  })

  test('a browser lacking the approval scopes is sent to the server’s device', async () => {
    answer = () => ({
      status: 200,
      body: wideningConsent(['wildflower/AuthorizationRequest.u']),
    })
    renderPage()

    expect(
      await screen.findByText(
        "Approve this on the device running your server: open its notification, or the server's page in the Wildflower app."
      )
    ).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  test('a widening no longer pending says so, and steps back out in then=back mode', async () => {
    answer = () => NOT_FOUND
    renderPage(Option.some(goBack))

    expect(
      await screen.findByText(
        'This request was already decided or has expired. You can close this.'
      )
    ).toBeDefined()
    await waitFor(() => {
      expect(goBack).toHaveBeenCalledTimes(1)
    })
  })

  test('a decision that finds the widening already settled says so', async () => {
    answer = serverHolding(NOT_FOUND)
    const { user } = renderPage()

    await user.click(await screen.findByRole('button', { name: 'Approve' }))

    expect(
      await screen.findByText('This request was already decided or has expired.')
    ).toBeDefined()
  })
})
