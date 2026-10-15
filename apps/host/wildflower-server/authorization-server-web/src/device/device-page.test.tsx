import { HttpClient, HttpClientResponse } from '@effect/platform'
import type { HttpClientRequest } from '@effect/platform'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Layer, Option } from 'effect'
import { type JSX, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  OWNER_BROWSER_SESSION_HEADER,
  ownerBrowserSessionRunner,
} from '../owner-browser-session.ts'
import { DevicePage } from './device-page.tsx'

/**
 * The device page against a stub server: every request goes through the real
 * runner, client and decoders, over a transport that answers like the
 * authorization server does, so the tests see exactly what the page reads and
 * sends.
 */

const SERVER_ORIGIN = 'https://ruth.relay.example'

/**
 * A request the stub server saw: its method, path, JSON body, and the session
 * it asked the server for (`Wildflower-Session`).
 */
interface SeenRequest {
  readonly method: string
  readonly path: string
  readonly body: unknown
  readonly session: string | undefined
}

/**
 * How the stub server answers one request, by method and path: a JSON `body`,
 * or a `text` body sent as it is.
 */
type Answer = (
  request: SeenRequest
) =>
  | { readonly status: number; readonly body: unknown }
  | { readonly status: number; readonly text: string }

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
      session: request.headers[OWNER_BROWSER_SESSION_HEADER.name.toLowerCase()],
    }
    seen.push(seenRequest)
    const reply = answer(seenRequest)
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        'text' in reply
          ? new Response(reply.text, {
              status: reply.status,
              headers: { 'content-type': 'text/plain' },
            })
          : new Response(JSON.stringify(reply.body), {
              status: reply.status,
              headers: { 'content-type': 'application/json' },
            })
      )
    )
  })
)

/** The pending device request the stub server holds for `userCode`. */
const deviceConsentFor = (userCode: string): unknown => ({
  userCode,
  clientId: 'pebble-watch',
  clientName: 'Pebble Watch',
  deviceName: null,
  requestedScopes: ['system/Observation.rs'],
  allowedScopes: ['system/Observation.rs'],
})

/** The path of the session read the page makes on load. */
const SESSION_PATH = '/authorization/session'

/** The scopes an Owner browser session holds. */
const OWNER_SCOPES = ['system/*.cruds', 'wildflower/*.cruds']

/**
 * A stub server whose session holds `sessionScopes`, holding a pending request
 * for `userCode` only, deciding it with `decision`.
 */
const serverHolding =
  (userCode: string, decision: unknown, sessionScopes: readonly string[] = OWNER_SCOPES): Answer =>
  (request) => {
    if (request.path === SESSION_PATH) return { status: 200, body: { scopes: sessionScopes } }
    if (request.path === `/authorization/devices/${userCode}`) {
      return { status: 200, body: deviceConsentFor(userCode) }
    }
    if (request.path.startsWith(`/authorization/devices/${userCode}/`)) {
      return { status: 200, body: decision }
    }
    const unknownCode = /^\/authorization\/devices\/([^/]+)$/.exec(request.path)?.[1]
    if (unknownCode !== undefined) {
      return { status: 404, body: { error: 'DeviceConsentNotFound', userCode: unknownCode } }
    }
    return { status: 404, body: {} }
  }

const goBack = vi.fn<() => void>()

beforeEach(() => {
  seen = []
  goBack.mockReset()
  // jsdom has no scrollIntoView; the card scrolls its error banner into view.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
})

/** How the page was opened: plainly, or with `then=back`. */
type OpenedWith = 'no-then' | 'then-back'

const renderPage = (
  initialUserCode: string,
  openedWith: OpenedWith = 'no-then'
): { readonly user: ReturnType<typeof userEvent.setup>; readonly queryClient: QueryClient } => {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  render(
    <DevicePage
      initialUserCode={initialUserCode}
      runAuthed={ownerBrowserSessionRunner(SERVER_ORIGIN, stubServer)}
      goBackOnceDecided={openedWith === 'then-back' ? Option.some(goBack) : Option.none()}
    />,
    { wrapper }
  )
  return { user: userEvent.setup({ delay: null }), queryClient }
}

/** The device requests (reads and decisions) the stub server received. */
const deviceCalls = (): readonly SeenRequest[] =>
  seen.filter((request) => request.path.startsWith('/authorization/devices/'))

/** The decisions (`approve` / `deny`) the stub server received. */
const decisions = (): readonly SeenRequest[] => seen.filter((request) => request.method === 'POST')

describe('DevicePage — the code', () => {
  test('the code from the link fills the box, and nothing is read until the Owner confirms it', async () => {
    answer = serverHolding('WDJB-MJHT', { status: 'approved' })
    const { user } = renderPage('wdjb-mjht')

    expect((await screen.findByLabelText<HTMLInputElement>('Code')).value).toBe('WDJB-MJHT')
    expect(seen.map((request) => request.path)).toEqual([SESSION_PATH])

    await user.click(await screen.findByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Pebble Watch')).toBeDefined()
    expect(deviceCalls().map((request) => request.path)).toEqual([
      '/authorization/devices/WDJB-MJHT',
    ])
  })

  test('an unknown code shows an error, and the Owner can enter another', async () => {
    answer = serverHolding('WDJB-MJHT', { status: 'approved' })
    const { user } = renderPage('BCDF-GHJK')

    await user.click(await screen.findByRole('button', { name: 'Continue' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'No device is waiting with this code.'
    )
    const codeBox = screen.getByLabelText('Code')
    await user.clear(codeBox)
    await user.type(codeBox, 'WDJB-MJHT')
    await user.click(await screen.findByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Pebble Watch')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('DevicePage — the session read', () => {
  test('is read once: refocusing the page, or a later failed read, leaves the open card', async () => {
    const holding = serverHolding('WDJB-MJHT', { status: 'approved' })
    answer = holding
    const { user, queryClient } = renderPage('WDJB-MJHT')

    await user.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Pebble Watch')).toBeDefined()

    answer = (request) =>
      request.path === SESSION_PATH ? { status: 500, body: {} } : holding(request)
    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    focusManager.setFocused(undefined)
    expect(seen.filter((request) => request.path === SESSION_PATH)).toHaveLength(1)

    await act(async () => {
      await queryClient.refetchQueries()
      // React Query notifies its observers on the next macrotask.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(seen.filter((request) => request.path === SESSION_PATH)).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined()
  })
})

describe('DevicePage — deciding', () => {
  test('approving sends the scopes on the Owner browser session and says to return to the device', async () => {
    answer = serverHolding('WDJB-MJHT', { status: 'approved' })
    const { user } = renderPage('WDJB-MJHT')

    await user.click(await screen.findByRole('button', { name: 'Continue' }))
    await user.click(await screen.findByRole('button', { name: 'Approve' }))

    expect(
      await screen.findByText('The device is approved. You can return to it now.')
    ).toBeDefined()
    expect(decisions()).toEqual([
      {
        method: 'POST',
        path: '/authorization/devices/WDJB-MJHT/approve',
        body: { approvedScopes: ['system/Observation.rs'] },
        session: OWNER_BROWSER_SESSION_HEADER.value,
      },
    ])
    expect(new Set(seen.map((request) => request.session))).toEqual(
      new Set([OWNER_BROWSER_SESSION_HEADER.value])
    )
  })

  test('declining denies the request and says so', async () => {
    answer = serverHolding('WDJB-MJHT', { status: 'denied' })
    const { user } = renderPage('WDJB-MJHT')

    await user.click(await screen.findByRole('button', { name: 'Continue' }))
    await user.click(await screen.findByRole('button', { name: 'Decline' }))

    expect(await screen.findByText('The request was declined.')).toBeDefined()
    expect(decisions().map((request) => request.path)).toEqual([
      '/authorization/devices/WDJB-MJHT/deny',
    ])
    expect(goBack).not.toHaveBeenCalled()
  })

  test('a request that expired before the decision says so, and the Owner can enter a new code', async () => {
    const holding = serverHolding('WDJB-MJHT', { status: 'approved' })
    answer = (request) =>
      request.method === 'POST'
        ? { status: 404, body: { error: 'DeviceConsentNotFound', userCode: 'WDJB-MJHT' } }
        : holding(request)
    window.history.replaceState(null, '', '/oauth/device?user_code=WDJB-MJHT')
    const { user } = renderPage('WDJB-MJHT')

    await user.click(await screen.findByRole('button', { name: 'Continue' }))
    await user.click(await screen.findByRole('button', { name: 'Approve' }))

    expect(
      await screen.findByText(
        'This device request has expired or was already decided. Start pairing again on the device to get a new code.'
      )
    ).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Enter a new code' }))

    expect((await screen.findByLabelText<HTMLInputElement>('Code')).value).toBe('')
    expect(window.location.search).toBe('')
  })
})

describe('DevicePage — then=back', () => {
  test.each([
    ['approving', 'Approve', 'approved', 'approve'],
    ['declining', 'Decline', 'denied', 'deny'],
  ])('%s says it is done and steps back', async (_case, button, status, decisionPath) => {
    answer = serverHolding('WDJB-MJHT', { status })
    const { user } = renderPage('WDJB-MJHT', 'then-back')

    await user.click(await screen.findByRole('button', { name: 'Continue' }))
    await user.click(await screen.findByRole('button', { name: button }))

    expect(await screen.findByText('Done. You can close this.')).toBeDefined()
    expect(goBack).toHaveBeenCalledOnce()
    expect(decisions().map((request) => request.path)).toEqual([
      `/authorization/devices/WDJB-MJHT/${decisionPath}`,
    ])
  })

  test('a browser that cannot decide here is still told to approve on the server', async () => {
    answer = () => ({ status: 401, body: {} })
    renderPage('WDJB-MJHT', 'then-back')

    expect(await screen.findByText(APPROVE_ON_SERVER)).toBeDefined()
    expect(goBack).not.toHaveBeenCalled()
  })
})

/** What the page says when this browser can't decide device requests. */
const APPROVE_ON_SERVER =
  "Approve this on the device running your server: open its notification, or the server's page in the Wildflower app."

describe('DevicePage — a browser that cannot decide here', () => {
  test('no session, as the server answers it (a 401 with no body), is told to approve on the server', async () => {
    answer = () => ({ status: 401, text: '' })
    renderPage('WDJB-MJHT')

    expect(await screen.findByText(APPROVE_ON_SERVER)).toBeDefined()
    expect(screen.queryByLabelText('Code')).toBeNull()
  })

  test('a session read that fails some other way says so in plain words', async () => {
    answer = () => ({ status: 500, text: 'not JSON' })
    renderPage('WDJB-MJHT')

    expect(
      await screen.findByText(
        "Couldn't check this browser's session. Approve the request on the device running your server instead."
      )
    ).toBeDefined()
    expect(screen.queryByText(/JSON/)).toBeNull()
    expect(screen.queryByLabelText('Code')).toBeNull()
  })

  test.each([
    ['no session', () => ({ status: 401, body: {} })],
    ['a session without the device scopes', serverHolding('WDJB-MJHT', {}, ['openid'])],
  ] as const)(
    '%s is told to approve on the server on load, with no code box and no device calls',
    async (_case, server) => {
      answer = server
      renderPage('WDJB-MJHT')

      expect(await screen.findByText(APPROVE_ON_SERVER)).toBeDefined()
      expect(screen.queryByLabelText('Code')).toBeNull()
      expect(seen.map((request) => request.path)).toEqual([SESSION_PATH])
    }
  )

  test.each([
    ['ended', 401, {}],
    ['lost the scope', 403, { error: 'InsufficientScope', missingScopes: [] }],
  ])(
    'a session that %s before Continue is told to approve on the server, and the request is left untouched',
    async (_case, status, body) => {
      answer = (request) =>
        request.path === SESSION_PATH
          ? { status: 200, body: { scopes: OWNER_SCOPES } }
          : { status, body }
      const { user } = renderPage('WDJB-MJHT')

      await user.click(await screen.findByRole('button', { name: 'Continue' }))

      expect(await screen.findByText(APPROVE_ON_SERVER)).toBeDefined()
      expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
      expect(decisions()).toEqual([])
    }
  )

  test.each([
    ['ended', 401, {}],
    ['lost the scope', 403, { error: 'InsufficientScope', missingScopes: [] }],
  ])(
    'a session that %s before the decision is told to approve on the server, with no Approve to retry',
    async (_case, status, body) => {
      const holding = serverHolding('WDJB-MJHT', { status: 'approved' })
      answer = (request) => (request.method === 'POST' ? { status, body } : holding(request))
      const { user } = renderPage('WDJB-MJHT')

      await user.click(await screen.findByRole('button', { name: 'Continue' }))
      await user.click(await screen.findByRole('button', { name: 'Approve' }))

      expect(await screen.findByText(APPROVE_ON_SERVER)).toBeDefined()
      expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    }
  )
})
