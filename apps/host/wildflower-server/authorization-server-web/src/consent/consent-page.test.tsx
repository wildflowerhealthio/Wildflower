import { HttpClient, HttpClientResponse, UrlParams } from '@effect/platform'
import type { HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Layer } from 'effect'
import { type JSX, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  OWNER_BROWSER_SESSION_HEADER,
  ownerBrowserSessionRunner,
} from '../owner-browser-session.ts'
import { ConsentPage } from './consent-page.tsx'

/**
 * The consent page against a stub server: every request goes through the real
 * runner, client and decoders, over a transport that answers like the
 * authorization server and the FHIR server do, so the tests see exactly what
 * the page reads, sends and leaves for.
 */

const SERVER_ORIGIN = 'https://ruth.relay.example'
const WAIT_PAGE = new URL(`${SERVER_ORIGIN}/oauth/authorize/req-1/wait`)

/**
 * A request the stub server saw: its method, path, query, JSON body, and the
 * session it asked the server for (`Wildflower-Session`).
 */
interface SeenRequest {
  readonly method: string
  readonly path: string
  readonly query: string
  readonly body: unknown
  readonly session: string | undefined
}

/** How the stub server answers one request, by method and path. */
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
    const url = new URL(request.url)
    const seenRequest: SeenRequest = {
      method: request.method,
      path: url.pathname,
      query: UrlParams.toString(request.urlParams),
      body: bodyOf(request),
      session: request.headers[OWNER_BROWSER_SESSION_HEADER.name.toLowerCase()],
    }
    seen.push(seenRequest)
    const { status, body } = answer(seenRequest)
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      )
    )
  })
)

/** The pending request the stub server holds for `scopes`. */
const consentFor = (scopes: readonly string[]): unknown => ({
  id: 'req-1',
  clientId: 'fitbit-sync',
  clientName: 'Fitbit Sync',
  scopes,
  redirectUri: 'https://app.example/cb',
  preApprovedScopes: [],
  patient: null,
  registration: { status: 'registered' },
})

/** A stub server holding `consent`, deciding with `decision`, and finding `patients`. */
const serverHolding =
  (consent: unknown, decision: unknown, patients: unknown = { resourceType: 'Bundle' }): Answer =>
  (request) => {
    if (request.path === '/authorization/oauth-consents/req-1') {
      return { status: 200, body: consent }
    }
    if (request.path.startsWith('/authorization/oauth-consents/req-1/')) {
      return { status: 200, body: decision }
    }
    if (request.path === '/Patient') return { status: 200, body: patients }
    return { status: 404, body: {} }
  }

const leaveFor = vi.fn<(destination: URL) => void>()

beforeEach(() => {
  seen = []
  leaveFor.mockReset()
  // jsdom has no scrollIntoView; the card scrolls its error banner into view.
  Element.prototype.scrollIntoView = vi.fn()
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
    <ConsentPage
      requestId="req-1"
      runAuthed={ownerBrowserSessionRunner(SERVER_ORIGIN, stubServer)}
      waitPage={WAIT_PAGE}
      leaveFor={leaveFor}
    />,
    { wrapper }
  )
  return { user: userEvent.setup({ delay: null }) }
}

/** The session each request the stub server received asked for. */
const sessionsAskedFor = (): readonly (string | undefined)[] =>
  seen.map((request) => request.session)

/** The approval bodies the stub server received. */
const approvals = (): readonly unknown[] =>
  seen.filter((request) => request.path.endsWith('/approve')).map((request) => request.body)

describe('ConsentPage — exit', () => {
  test('an approval leaves for the code callback its answer carries', async () => {
    answer = serverHolding(consentFor(['user/Observation.rs']), {
      status: 'approved',
      redirect: 'https://app.example/cb?code=c&state=s',
    })
    const { user } = renderPage()

    await user.click(await screen.findByRole('button', { name: 'Allow access' }))

    await waitFor(() => {
      expect(leaveFor).toHaveBeenCalledWith(new URL('https://app.example/cb?code=c&state=s'))
    })
    expect(screen.getByText('Returning you to the app…')).toBeDefined()
  })

  test('a denial leaves for the access_denied callback its answer carries', async () => {
    answer = serverHolding(consentFor(['user/Observation.rs']), {
      status: 'denied',
      redirect: 'https://app.example/cb?error=access_denied&state=s',
    })
    const { user } = renderPage()

    await user.click(await screen.findByRole('button', { name: 'Deny' }))

    await waitFor(() => {
      expect(leaveFor).toHaveBeenCalledWith(
        new URL('https://app.example/cb?error=access_denied&state=s')
      )
    })
    expect(
      seen.some((request) => request.path === '/authorization/oauth-consents/req-1/deny')
    ).toBe(true)
    expect(new Set(sessionsAskedFor())).toEqual(new Set([OWNER_BROWSER_SESSION_HEADER.value]))
  })

  test('the page refuses to leave for a callback that is not http(s)', async () => {
    answer = serverHolding(consentFor(['user/Observation.rs']), {
      status: 'approved',
      redirect: 'javascript:alert(1)',
    })
    const { user } = renderPage()

    await user.click(await screen.findByRole('button', { name: 'Allow access' }))

    expect(
      await screen.findByText('The authorization server returned an unexpected answer.')
    ).toBeDefined()
    expect(leaveFor).not.toHaveBeenCalled()
  })
})

describe('ConsentPage — a browser that cannot decide here', () => {
  test.each([
    ['not signed in as the Owner', 401, {}],
    ['signed in without the scope', 403, { error: 'InsufficientScope', missingScopes: [] }],
    ['a request that is no longer pending', 404, { error: 'OAuthConsentNotFound', id: 'req-1' }],
  ])('%s goes to the wait page', async (_case, status, body) => {
    answer = () => ({ status, body })
    renderPage()

    await waitFor(() => {
      expect(leaveFor).toHaveBeenCalledWith(WAIT_PAGE)
    })
    expect(screen.queryByRole('button', { name: 'Allow access' })).toBeNull()
  })
})

describe('ConsentPage — scopes', () => {
  test('unticking a requested scope narrows the approved scopes', async () => {
    answer = serverHolding(consentFor(['user/Observation.rs', 'openid']), {
      status: 'approved',
      redirect: 'https://app.example/cb?code=c&state=s',
    })
    const { user } = renderPage()

    await user.click(await screen.findByRole('switch', { name: /Confirm who you are/ }))
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    await waitFor(() => {
      expect(approvals()).toEqual([
        {
          approvedScopes: ['user/Observation.rs'],
          patient: null,
          acknowledgedRegistration: false,
        },
      ])
    })
  })
})

describe('ConsentPage — patient search', () => {
  test('a request that asks for no patient shows no patient search and reads no patients', async () => {
    answer = serverHolding(consentFor(['user/Observation.rs', 'openid']), { status: 'denied' })
    renderPage()

    await screen.findByRole('button', { name: 'Allow access' })

    expect(screen.queryByRole('searchbox', { name: 'Find a patient' })).toBeNull()
    expect(seen.some((request) => request.path === '/Patient')).toBe(false)
  })

  test('a request that asks for launch/patient searches the server by name', async () => {
    answer = serverHolding(
      consentFor(['launch/patient', 'openid']),
      { status: 'approved', redirect: 'https://app.example/cb?code=c&state=s' },
      {
        resourceType: 'Bundle',
        entry: [
          {
            resource: {
              resourceType: 'Patient',
              id: 'pat-1',
              name: [{ given: ['Jordan'], family: 'Lee' }],
            },
          },
          { resource: { resourceType: 'OperationOutcome' } },
        ],
      }
    )
    const { user } = renderPage()

    await user.type(await screen.findByRole('searchbox', { name: 'Find a patient' }), 'Lee')
    await waitFor(() => {
      expect(seen.map((request) => request.query)).toContain('_count=20&name=Lee')
    })
    await user.click(screen.getByRole('button', { name: /No patient/ }))
    await user.click(await screen.findByRole('option', { name: /Jordan Lee/ }))
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    await waitFor(() => {
      expect(approvals()).toEqual([
        {
          approvedScopes: ['launch/patient', 'openid'],
          patient: 'pat-1',
          acknowledgedRegistration: false,
        },
      ])
    })
    // The consent read, the search and the approval each act as the Owner,
    // even in a browser signed in to the FHIR web UI too.
    expect(seen.map((request) => request.path)).toEqual(
      expect.arrayContaining([
        '/authorization/oauth-consents/req-1',
        '/Patient',
        '/authorization/oauth-consents/req-1/approve',
      ])
    )
    expect(new Set(sessionsAskedFor())).toEqual(new Set([OWNER_BROWSER_SESSION_HEADER.value]))
  })
})
