import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Layer } from 'effect'
import { type JSX } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  sessionWideningMutationOptions,
  type RunAuthed,
  type SessionWideningConsent,
  type SessionWideningResult,
} from '../../queries/index.ts'
import { sliceRuntimeLayer, type RuntimeLayer } from '../../router-context.ts'
import { SessionWideningCard } from './session-widening-card.tsx'

/**
 * `SessionWideningCard`'s chrome and decision wiring: what asks and for which app, and
 * that Approve sends what is left ticked and Decline denies. The scope-editing mechanics
 * are `scopes-react`'s `ScopePicker`'s, tested there. The decision runs through a real
 * `useMutation` over `sessionWideningMutationOptions`, the real client and decoders, over a
 * transport that records what it was sent.
 */

afterEach(() => {
  cleanup()
})

/** A widening of Firefox on Linux's session, for Strength, asking for one scope. */
const consent: SessionWideningConsent = {
  id: 'widen-1',
  browserName: 'Firefox on Linux',
  clientId: 'wildflower-strength',
  clientName: 'Wildflower Strength',
  requestedScopes: ['wildflower/Apps.r'],
  startingScopes: ['wildflower/Apps.r'],
  missingApprovalScopes: [],
}

/**
 * The card over a real mutation, on a runner whose transport answers every request with
 * `result`, and the request bodies it sent, by path.
 */
const renderCard = (
  result: SessionWideningResult
): {
  readonly sent: { readonly path: string; readonly body: unknown }[]
  readonly onDone: ReturnType<typeof vi.fn>
} => {
  const sent: { path: string; body: unknown }[] = []
  const onDone = vi.fn()
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      sent.push({
        path: new URL(request.url).pathname,
        body:
          request.body._tag === 'Uint8Array'
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined,
      })
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(result, { status: 200 }))
      )
    })
  )
  const runtimeLayer: RuntimeLayer = Layer.provideMerge(
    sliceRuntimeLayer,
    Layer.effect(
      HttpClient.HttpClient,
      Effect.map(
        HttpClient.HttpClient,
        HttpClient.mapRequest(HttpClientRequest.prependUrl('https://ruth.relay.example'))
      )
    ).pipe(Layer.provide(transport))
  )
  const runAuthed: RunAuthed = (effect, options) =>
    Effect.runPromise(Effect.provide(effect, runtimeLayer), options)
  const Host = (): JSX.Element => {
    const consentMutation = useMutation(sessionWideningMutationOptions(runAuthed))
    return (
      <SessionWideningCard consent={consent} consentMutation={consentMutation} onDone={onDone} />
    )
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Host />
    </QueryClientProvider>
  )
  return { sent, onDone }
}

describe('SessionWideningCard', () => {
  test('names the browser that asks and the app it asks for', () => {
    renderCard({ status: 'approved' })

    expect(screen.getByText('Firefox on Linux')).toBeDefined()
    expect(screen.getByText('Wildflower Strength')).toBeDefined()
    expect(screen.getByText('wildflower-strength')).toBeDefined()
  })

  test('Approve sends the scopes left ticked', async () => {
    const { sent, onDone } = renderCard({ status: 'approved' })

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledWith({ status: 'approved' })
    })
    expect(sent).toEqual([
      {
        path: '/authorization/session-widenings/widen-1/approve',
        body: { approvedScopes: ['wildflower/Apps.r'] },
      },
    ])
  })

  test('Decline denies the widening', async () => {
    const { sent, onDone } = renderCard({ status: 'denied' })

    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledWith({ status: 'denied' })
    })
    expect(sent).toEqual([
      { path: '/authorization/session-widenings/widen-1/deny', body: undefined },
    ])
  })
})
