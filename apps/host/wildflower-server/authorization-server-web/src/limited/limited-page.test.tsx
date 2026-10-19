import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Layer } from 'effect'
import { type JSX, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { BROWSER_SESSION_HEADER, browserSessionRunner } from '../browser-session.ts'
import { LimitedPage } from './limited-page.tsx'

/**
 * The limited page against a stub server: every request goes through the real
 * runner, client and decoders, over a transport that answers like the
 * authorization server does, so the tests see exactly what the page reads,
 * sends and leaves for.
 */

const SERVER_ORIGIN = 'https://ruth.relay.example'
const WAIT_PAGE = new URL(`${SERVER_ORIGIN}/oauth/authorize/req-1/wait`)

/** A request the stub server saw: its method, path, and the session it asked for. */
interface SeenRequest {
  readonly method: string
  readonly path: string
  readonly session: string | undefined
}

/** How the stub server answers one request: a JSON `body`, or a `text` body. */
type Answer = (
  request: SeenRequest
) =>
  | { readonly status: number; readonly body: unknown }
  | { readonly status: number; readonly text: string }

let seen: SeenRequest[] = []
let answer: Answer = () => ({ status: 404, body: {} })

const responseTo = (reply: ReturnType<Answer>): Response =>
  'text' in reply
    ? new Response(reply.text, { status: reply.status, headers: { 'content-type': 'text/plain' } })
    : new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      })

const stubServer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    const url = new URL(request.url)
    const seenRequest: SeenRequest = {
      method: request.method,
      path: url.pathname,
      session: request.headers[BROWSER_SESSION_HEADER.name.toLowerCase()],
    }
    seen.push(seenRequest)
    return Effect.succeed(HttpClientResponse.fromWeb(request, responseTo(answer(seenRequest))))
  })
)

/** The `404` the server answers for a request that no longer waits on this page. */
const NOT_FOUND = { status: 404, body: { error: 'AuthorizationRequestNotFound', id: 'req-1' } }

/**
 * A stub server holding request `req-1`, whose session lacks `missingScopes`
 * of what Strength asks for, answering Continue with `continued` and Cancel
 * with `cancelled`.
 */
const serverHolding =
  (
    missingScopes: readonly string[],
    continued: ReturnType<Answer> = NOT_FOUND,
    cancelled: ReturnType<Answer> = NOT_FOUND
  ): Answer =>
  (request) => {
    if (request.path === '/oauth/authorize/req-1/session-shortfall') {
      return { status: 200, body: { clientName: 'Strength', missingScopes } }
    }
    if (request.path === '/oauth/authorize/req-1/continue') return continued
    if (request.path === '/oauth/authorize/req-1/cancel') return cancelled
    return { status: 404, body: {} }
  }

const leaveFor = vi.fn<(destination: URL) => void>()

beforeEach(() => {
  seen = []
  leaveFor.mockReset()
})

afterEach(() => {
  cleanup()
})

const renderPage = (): { readonly user: ReturnType<typeof userEvent.setup> } => {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  render(
    <LimitedPage
      requestId="req-1"
      runAuthed={browserSessionRunner(SERVER_ORIGIN, stubServer)}
      waitPage={WAIT_PAGE}
      leaveFor={leaveFor}
    />,
    { wrapper }
  )
  return { user: userEvent.setup({ delay: null }) }
}

/** The paths of the `POST`s the stub server received. */
const posted = (): readonly string[] =>
  seen.filter((request) => request.method === 'POST').map((request) => request.path)

describe('LimitedPage — what it says', () => {
  test('names what this browser isn’t allowed to do in plain words, above Cancel and Continue', async () => {
    answer = serverHolding(['patient/Observation.rs', 'wildflower/launch'])
    renderPage()

    const message = await screen.findByText(/This browser isn't allowed to/)
    expect(message.textContent).toBe(
      "This browser isn't allowed to read and search Observations and launch apps you have access to, which Strength expects. Strength may not be able to do everything."
    )
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const continueButton = screen.getByRole('button', { name: 'Continue' })
    // The message comes first; nothing follows the buttons.
    expect(message.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      cancel.compareDocumentPosition(continueButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(continueButton.parentElement?.nextElementSibling).toBeNull()
    expect(new Set(seen.map((request) => request.session))).toEqual(
      new Set([BROWSER_SESSION_HEADER.value])
    )
  })

  test('a request no longer waiting here leaves for the wait page', async () => {
    answer = () => NOT_FOUND
    renderPage()

    await waitFor(() => {
      expect(leaveFor).toHaveBeenCalledWith(WAIT_PAGE)
    })
  })

  test('a read that fails some other way says so in plain words', async () => {
    answer = () => ({ status: 500, text: 'boom' })
    renderPage()

    expect(
      await screen.findByText("Couldn't read this request. Go back to the app and try again.")
    ).toBeDefined()
    expect(leaveFor).not.toHaveBeenCalled()
  })
})

describe('LimitedPage — Continue and Cancel', () => {
  test('Continue leaves for the client callback the server answers with', async () => {
    answer = serverHolding(['patient/Observation.rs'], {
      status: 200,
      body: { location: 'https://app.example/cb?code=c&state=s' },
    })
    const { user } = renderPage()

    await user.click(await screen.findByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(leaveFor).toHaveBeenCalledWith(new URL('https://app.example/cb?code=c&state=s'))
    })
    expect(posted()).toEqual(['/oauth/authorize/req-1/continue'])
  })

  test('Continue leaves for the wait page or consent card path the server answers with', async () => {
    answer = serverHolding(['patient/Observation.rs'], {
      status: 200,
      body: { location: '/oauth/authorize/req-1/consent' },
    })
    const { user } = renderPage()

    await user.click(await screen.findByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(leaveFor).toHaveBeenCalledWith(
        new URL(`${SERVER_ORIGIN}/oauth/authorize/req-1/consent`)
      )
    })
  })

  test('Cancel leaves for the access_denied callback', async () => {
    answer = serverHolding(['patient/Observation.rs'], NOT_FOUND, {
      status: 200,
      body: { location: 'https://app.example/cb?error=access_denied&state=s' },
    })
    const { user } = renderPage()

    await user.click(await screen.findByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(leaveFor).toHaveBeenCalledWith(
        new URL('https://app.example/cb?error=access_denied&state=s')
      )
    })
    expect(posted()).toEqual(['/oauth/authorize/req-1/cancel'])
  })

  test('a Continue on a request no longer waiting leaves for the wait page', async () => {
    answer = serverHolding(['patient/Observation.rs'])
    const { user } = renderPage()

    await user.click(await screen.findByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(leaveFor).toHaveBeenCalledWith(WAIT_PAGE)
    })
  })

  test('the page refuses to leave for a location that is not http(s)', async () => {
    answer = serverHolding(['patient/Observation.rs'], {
      status: 200,
      body: { location: 'javascript:alert(1)' },
    })
    const { user } = renderPage()

    await user.click(await screen.findByRole('button', { name: 'Continue' }))

    expect(
      await screen.findByText("Couldn't finish this request. Go back to the app and try again.")
    ).toBeDefined()
    expect(leaveFor).not.toHaveBeenCalled()
  })
})
