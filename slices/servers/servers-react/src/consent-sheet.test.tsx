import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type Context, Schema } from 'effect'
import { ConsentKey, type TauriInvoke } from 'servers-core'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import golden from '../../servers-wire-golden.json' with { type: 'json' }
import { ConsentSheet } from './consent-sheet.tsx'
import { type ListenToHostEvent, runHostCommandWith } from './router-context.ts'

const RUTH = 'ruth.relay.example.com'
const LAB = 'lab.rathole.example.com'

/** One invoke the fake host saw. */
interface SeenInvoke {
  readonly command: string
  readonly args: Readonly<Record<string, unknown>> | undefined
}

/**
 * A host whose `pending_consents_list` answers `waiting`, whose
 * `server_consent_get` answers from `details` by the consent's key, and whose
 * approve and deny answer `approval`; every invoke is recorded.
 */
const fakeHost = ({
  waiting,
  details,
  approval = { status: 'approved' },
}: {
  readonly waiting: readonly unknown[]
  readonly details: Readonly<Record<string, unknown>>
  readonly approval?: unknown
}): { readonly invoke: Context.Tag.Service<TauriInvoke>; readonly seen: SeenInvoke[] } => {
  const seen: SeenInvoke[] = []
  const answers: Readonly<Record<string, (args: Record<string, unknown> | undefined) => unknown>> =
    {
      pending_consents_list: () => waiting,
      server_consent_get: (args) => {
        const consent = Schema.decodeUnknownSync(ConsentKey.Schema)(args?.['consent'])
        return details[consent.kind === 'device' ? consent.userCode : consent.id]
      },
      server_consent_approve: () => approval,
      server_consent_deny: () => null,
    }
  return {
    seen,
    invoke: (command, args) => {
      seen.push({ command, args })
      const answer = answers[command]
      return answer === undefined
        ? Promise.reject(new Error(`unexpected command ${command}`))
        : Promise.resolve(answer(args))
    },
  }
}

/** Host events a test emits to the listeners the sheet has up. */
const fakeEvents = (): {
  readonly listen: ListenToHostEvent
  readonly emit: (event: string, payload: unknown) => void
} => {
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

const renderSheet = (
  host: ReturnType<typeof fakeHost>,
  events = fakeEvents()
): ReturnType<typeof fakeEvents> => {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ConsentSheet
        runHostCommand={runHostCommandWith(host.invoke)}
        listenToHostEvent={events.listen}
      />
    </QueryClientProvider>
  )
  return events
}

/** The sheet while it is open. */
const sheet = async (): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(document.querySelector('dialog[open]')).not.toBeNull()
  })
  const dialog = document.querySelector<HTMLElement>('dialog[open]')
  if (dialog === null) throw new Error('the sheet closed')
  return dialog
}

const commandsSeen = (seen: readonly SeenInvoke[], command: string): readonly SeenInvoke[] =>
  seen.filter((invoke) => invoke.command === command)

/** jsdom has no native `<dialog>`: `showModal` and `close` are modelled as its `open` attribute. */
const dialogMethodDescriptors = (['showModal', 'close'] as const).map(
  (method) =>
    [method, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method)] as const
)

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
})

afterEach(() => {
  cleanup()
  for (const [method, descriptor] of dialogMethodDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, method)
    else Object.defineProperty(HTMLDialogElement.prototype, method, descriptor)
  }
})

/** Two servers each with a consent waiting: a device pairing with Ruth's, an app's request with the lab's. */
const twoWaiting = (approval?: unknown): ReturnType<typeof fakeHost> =>
  fakeHost({
    waiting: [golden.pendingConsents[0], golden.pendingConsents[1]],
    details: {
      'ABCD-EFGH': golden.consentDetails.device,
      'req-1': golden.consentDetails.oauthRegistered,
    },
    approval,
  })

describe('ConsentSheet', () => {
  it('should stay closed while nothing waits', async () => {
    // Arrange
    const host = fakeHost({ waiting: [], details: {} })

    // Act
    renderSheet(host)

    // Assert
    await waitFor(() => {
      expect(commandsSeen(host.seen, 'pending_consents_list').length).toBeGreaterThan(0)
    })
    expect(document.querySelector('dialog[open]')).toBeNull()
  })

  it('should ask about the first server in the queue, saying where it stands', async () => {
    // Arrange
    const host = twoWaiting()

    // Act
    renderSheet(host)

    // Assert
    const dialog = await sheet()
    expect(within(dialog).getByText('1 of 2')).toBeDefined()
    expect(await within(dialog).findByRole('heading', { name: 'Pebble sync' })).toBeDefined()
    expect(within(dialog).getByText(RUTH)).toBeDefined()
    expect(within(dialog).getByText("Ruth's watch")).toBeDefined()
    expect(within(dialog).getByText('ABCD-EFGH')).toBeDefined()
  })

  it('should approve what the request asked for, then move on to the next server', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = twoWaiting()
    const events = renderSheet(host)
    const dialog = await sheet()
    await within(dialog).findByRole('heading', { name: 'Pebble sync' })

    // Act
    await user.click(within(dialog).getByRole('button', { name: 'Allow' }))

    // Assert
    expect(commandsSeen(host.seen, 'server_consent_approve')).toEqual([
      {
        command: 'server_consent_approve',
        args: { domain: RUTH, approval: golden.consentApprovals[0] },
      },
    ])
    const next = await sheet()
    expect(await within(next).findByRole('heading', { name: 'Lifting' })).toBeDefined()
    expect(within(next).getByText('1 of 1')).toBeDefined()
    expect(within(next).getByText('https://lifting.example.com')).toBeDefined()

    // Act: the host confirms Ruth's server has nothing more waiting
    events.emit('pending-consent', golden.pendingConsents[2])

    // Assert
    await waitFor(() => {
      expect(within(next).getByText('1 of 1')).toBeDefined()
    })
  })

  it('should deny a request by its key', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = fakeHost({
      waiting: [golden.pendingConsents[1]],
      details: { 'req-1': golden.consentDetails.oauthRegistered },
    })
    renderSheet(host)
    const dialog = await sheet()
    await within(dialog).findByRole('heading', { name: 'Lifting' })

    // Act
    await user.click(within(dialog).getByRole('button', { name: 'Deny' }))

    // Assert
    expect(commandsSeen(host.seen, 'server_consent_deny')).toEqual([
      {
        command: 'server_consent_deny',
        args: { domain: LAB, consent: golden.consentKeys[1] },
      },
    ])
    await waitFor(() => {
      expect(document.querySelector('dialog[open]')).toBeNull()
    })
  })

  it('should hold Allow for a new app until the Owner acknowledges it', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = fakeHost({
      waiting: [{ domain: LAB, head: { kind: 'oauth', id: 'req-2' } }],
      details: { 'req-2': golden.consentDetails.oauthNew },
    })
    renderSheet(host)
    const dialog = await sheet()
    const allow = await within(dialog).findByRole('button', { name: 'Allow' })
    expect(allow).toHaveProperty('disabled', true)

    // Act
    await user.click(within(dialog).getByRole('checkbox', { name: /I recognise this app/ }))
    await user.click(allow)

    // Assert
    expect(commandsSeen(host.seen, 'server_consent_approve')).toEqual([
      {
        command: 'server_consent_approve',
        args: {
          domain: LAB,
          approval: {
            kind: 'oauth',
            id: 'req-2',
            approvedScopes: ['openid'],
            acknowledgedRegistration: true,
          },
        },
      },
    ])
  })

  it("should send an app's request the patient its grant names", async () => {
    // Arrange
    const user = userEvent.setup()
    const host = fakeHost({
      waiting: [golden.pendingConsents[1]],
      details: { 'req-1': golden.consentDetails.oauthRegistered },
    })
    renderSheet(host)
    const dialog = await sheet()
    await within(dialog).findByText('Patient')

    // Act
    await user.click(within(dialog).getByRole('button', { name: 'Allow' }))

    // Assert
    expect(commandsSeen(host.seen, 'server_consent_approve')).toEqual([
      {
        command: 'server_consent_approve',
        args: {
          domain: LAB,
          approval: {
            kind: 'oauth',
            id: 'req-1',
            approvedScopes: ['patient/Observation.rs', 'launch/patient'],
            patient: 'pat-1',
            acknowledgedRegistration: false,
          },
        },
      },
    ])
  })

  it('should say so when an approval granted nothing, and move on, as the request was denied', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = twoWaiting({ status: 'denied' })
    renderSheet(host)
    const dialog = await sheet()
    await within(dialog).findByRole('heading', { name: 'Pebble sync' })

    // Act
    await user.click(within(dialog).getByRole('button', { name: 'Allow' }))

    // Assert
    const next = await sheet()
    expect(await within(next).findByRole('heading', { name: 'Lifting' })).toBeDefined()
    expect(within(next).getByText(/nothing you allowed could be granted/)).toBeDefined()
    expect(within(next).getByText('1 of 1')).toBeDefined()
  })

  it('should say an approval granted nothing even when the host confirms it was taken off the queue first', async () => {
    // Arrange
    const user = userEvent.setup()
    let answerApproval: (outcome: unknown) => void = () => undefined
    const host = fakeHost({
      waiting: [golden.pendingConsents[0]],
      details: { 'ABCD-EFGH': golden.consentDetails.device },
      approval: new Promise((resolve) => {
        answerApproval = resolve
      }),
    })
    const events = renderSheet(host)
    const dialog = await sheet()
    await within(dialog).findByRole('heading', { name: 'Pebble sync' })
    await user.click(within(dialog).getByRole('button', { name: 'Allow' }))

    // Act: the event that Ruth's server has nothing waiting beats the approval's answer
    events.emit('pending-consent', golden.pendingConsents[2])
    await waitFor(() => {
      expect(document.querySelector('dialog[open]')).toBeNull()
    })
    answerApproval({ status: 'denied' })

    // Assert
    const notice = await sheet()
    expect(await within(notice).findByText(/nothing you allowed could be granted/)).toBeDefined()
  })

  it('should keep saying an approval granted nothing when nothing else waits, until closed', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = fakeHost({
      waiting: [golden.pendingConsents[0]],
      details: { 'ABCD-EFGH': golden.consentDetails.device },
      approval: { status: 'denied' },
    })
    renderSheet(host)
    const dialog = await sheet()
    await within(dialog).findByRole('heading', { name: 'Pebble sync' })

    // Act
    await user.click(within(dialog).getByRole('button', { name: 'Allow' }))

    // Assert
    const notice = await sheet()
    expect(await within(notice).findByText(/nothing you allowed could be granted/)).toBeDefined()
    expect(within(notice).queryByRole('button', { name: 'Allow' })).toBeNull()

    // Act
    await user.click(within(notice).getByRole('button', { name: 'Close' }))

    // Assert
    await waitFor(() => {
      expect(document.querySelector('dialog[open]')).toBeNull()
    })
  })

  it('should add a consent the host announces, and set one aside when closed unanswered', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = fakeHost({
      waiting: [golden.pendingConsents[0]],
      details: {
        'ABCD-EFGH': golden.consentDetails.device,
        'req-1': golden.consentDetails.oauthRegistered,
      },
    })
    const events = renderSheet(host)
    const dialog = await sheet()
    await within(dialog).findByRole('heading', { name: 'Pebble sync' })

    // Act
    events.emit('pending-consent', golden.pendingConsents[1])

    // Assert
    expect(await within(dialog).findByText('1 of 2')).toBeDefined()

    // Act
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))

    // Assert
    const next = await sheet()
    expect(await within(next).findByRole('heading', { name: 'Lifting' })).toBeDefined()
    expect(within(next).getByText('1 of 1')).toBeDefined()
    expect(commandsSeen(host.seen, 'server_consent_deny')).toEqual([])
  })
})
