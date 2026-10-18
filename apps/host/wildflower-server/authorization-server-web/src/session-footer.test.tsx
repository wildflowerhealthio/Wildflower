import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { formatInstant } from '@wildflowerhealthio/authorization-react'
import { DateTime, Effect, Layer } from 'effect'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { browserSessionRunner } from './browser-session.ts'
import { SessionFooter } from './session-footer.tsx'
import { SESSION_QUERY_KEY } from './session-query.ts'

/**
 * The footer against a stub server answering `GET /authorization/session`
 * with `status` and `body`, through the real runner, client and decoders.
 */

const SERVER_ORIGIN = 'https://ruth.relay.example'

const EXPIRES_AT = '2026-10-17T16:00:00.000Z'

/** Render the footer over the stub server; the query client it reads through. */
const renderFooter = (status: number, body: unknown): QueryClient => {
  const stubServer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new URL(request.url).pathname === '/authorization/session'
            ? new Response(JSON.stringify(body), {
                status,
                headers: { 'content-type': 'application/json' },
              })
            : new Response(null, { status: 404 })
        )
      )
    )
  )
  const queryClient = new QueryClient()
  render(
    <QueryClientProvider client={queryClient}>
      <SessionFooter runAuthed={browserSessionRunner(SERVER_ORIGIN, stubServer)} />
    </QueryClientProvider>
  )
  return queryClient
}

afterEach(() => {
  cleanup()
})

describe('SessionFooter', () => {
  test('a browser session shows until when, and a Sign out form posting to the sign-out', async () => {
    renderFooter(200, { scopes: ['wildflower/*.cruds'], browserSessionExpiresAt: EXPIRES_AT })

    const until = `Signed in until ${formatInstant(DateTime.unsafeMake(EXPIRES_AT))}`
    expect(await screen.findByText(until)).toBeDefined()
    const signOut = screen.getByRole('button', { name: 'Sign out' })
    expect(signOut.getAttribute('type')).toBe('submit')
    const form = signOut.closest('form')
    expect(form?.getAttribute('method')).toBe('post')
    expect(form?.getAttribute('action')).toBe('/oauth/sign-out')
  })

  test.each([
    ['a token under no browser session', 200, { scopes: [], browserSessionExpiresAt: null }],
    ['no session', 401, {}],
  ])('%s shows no footer', async (_case, status, body) => {
    const queryClient = renderFooter(status, body)

    // The session read has settled, so nothing is still to render.
    await waitFor(() => {
      expect(queryClient.getQueryState(SESSION_QUERY_KEY)?.status).not.toBe('pending')
    })
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
    expect(screen.queryByText(/Signed in until/)).toBeNull()
  })
})
