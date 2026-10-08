import { Cause, Effect, Either, Exit, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import golden from '../../servers-wire-golden.json' with { type: 'json' }
import * as ApprovalOutcome from './approval-outcome.ts'
import * as ConsentApproval from './consent-approval.ts'
import {
  approveConsent,
  denyConsent,
  listPendingConsents,
  readConsent,
} from './consent-commands.ts'
import * as ConsentDetails from './consent-details.ts'
import * as ConsentKey from './consent-key.ts'
import { HostCommandFailed, TauriInvoke } from './host-commands.ts'
import * as PendingConsent from './pending-consent.ts'

/** One invoke the fake host saw. */
interface SeenInvoke {
  readonly command: string
  readonly args: Readonly<Record<string, unknown>> | undefined
}

/**
 * Run `effect` against a host that answers every command with `answer`, and
 * return its exit with the invokes the host saw.
 */
const runAgainstHostAnswering = async <A, E>(
  effect: Effect.Effect<A, E, TauriInvoke>,
  answer: () => Promise<unknown>
): Promise<{ readonly exit: Exit.Exit<A, E>; readonly seen: readonly SeenInvoke[] }> => {
  const seen: SeenInvoke[] = []
  const exit = await Effect.runPromiseExit(
    Effect.provideService(effect, TauriInvoke, (command, args) => {
      seen.push({ command, args })
      return answer()
    })
  )
  return { exit, seen }
}

const decodeDetails = Schema.decodeUnknownSync(ConsentDetails.Schema)

const DEVICE_KEY: ConsentKey.Type = { kind: 'device', userCode: 'ABCD-EFGH' }
const OAUTH_KEY: ConsentKey.Type = { kind: 'oauth', id: 'req-1' }

describe('PendingConsent', () => {
  it('should decode each pending consent, with no head once nothing waits', () => {
    // Act
    const decoded = golden.pendingConsents.map((payload) => PendingConsent.decodeEvent(payload))

    // Assert
    expect(decoded.map((either) => Either.map(either, (consent) => consent.head))).toEqual([
      Either.right(Option.some(DEVICE_KEY)),
      Either.right(Option.some(OAUTH_KEY)),
      Either.right(Option.none()),
    ])
  })

  it('should refuse a head of an unknown kind', () => {
    const decoded = PendingConsent.decodeEvent({
      domain: 'ruth.relay.example.com',
      head: { kind: 'password', id: 'x' },
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  it('should keep a server in its place, add a new one last, and drop a cleared one', () => {
    // Arrange
    const ruth = 'ruth.relay.example.com'
    const lab = 'lab.rathole.example.com'
    const waiting = PendingConsent.waitingOf([
      { domain: ruth, head: Option.some(DEVICE_KEY) },
      { domain: lab, head: Option.some(OAUTH_KEY) },
    ])
    const next: ConsentKey.Type = { kind: 'oauth', id: 'req-2' }

    // Act
    const moved = PendingConsent.withPendingConsent(waiting, {
      domain: ruth,
      head: Option.some(next),
    })
    const cleared = PendingConsent.withPendingConsent(moved, { domain: lab, head: Option.none() })
    const joined = PendingConsent.withPendingConsent(cleared, {
      domain: lab,
      head: Option.some(DEVICE_KEY),
    })

    // Assert
    expect(moved).toEqual([
      { domain: ruth, key: next },
      { domain: lab, key: OAUTH_KEY },
    ])
    expect(cleared).toEqual([{ domain: ruth, key: next }])
    expect(joined).toEqual([
      { domain: ruth, key: next },
      { domain: lab, key: DEVICE_KEY },
    ])
  })
})

describe('ConsentKey', () => {
  it('should decode the keys the host takes, and tell the flows apart', () => {
    // Act
    const keys = golden.consentKeys.map((key) => Schema.decodeUnknownSync(ConsentKey.Schema)(key))

    // Assert
    expect(keys).toEqual([DEVICE_KEY, OAUTH_KEY])
    expect(ConsentKey.asString({ kind: 'device', userCode: 'x' })).not.toBe(
      ConsentKey.asString({ kind: 'oauth', id: 'x' })
    )
  })

  it('should key a consent by the details the host read it as', () => {
    // Act
    const keys = [golden.consentDetails.device, golden.consentDetails.oauthRegistered].map(
      (details) => ConsentKey.of(decodeDetails(details))
    )

    // Assert
    expect(keys).toEqual([DEVICE_KEY, OAUTH_KEY])
  })
})

describe('ConsentDetails', () => {
  it("should decode a device's pairing with the name it gave itself", () => {
    // Act
    const details = decodeDetails(golden.consentDetails.device)

    // Assert
    expect(details.kind).toBe('device')
    expect(ConsentDetails.appNameOf(details)).toBe('Pebble sync')
    expect(details.kind === 'device' ? details.deviceName : Option.none()).toEqual(
      Option.some("Ruth's watch")
    )
  })

  it("should decode an app's request, with its redirect and the patient its launch binds", () => {
    // Act
    const details = decodeDetails(golden.consentDetails.oauthRegistered)

    // Assert
    expect(details.kind === 'oauth' ? details.redirectUri.origin : undefined).toBe(
      'https://lifting.example.com'
    )
    expect(details.kind === 'oauth' ? details.launchPatient : Option.none()).toEqual(
      Option.some('pat-1')
    )
  })

  it('should decode each registration, and an app named only by its id', () => {
    // Act
    const unseen = decodeDetails(golden.consentDetails.oauthNew)
    const changed = decodeDetails(golden.consentDetails.oauthChanged)

    // Assert
    expect(unseen.kind === 'oauth' ? unseen.registration : undefined).toEqual({ status: 'new' })
    expect(changed.kind === 'oauth' ? changed.registration : undefined).toEqual({
      status: 'changed',
      redirectUriIsNew: true,
      newScopes: ['patient/Condition.rs'],
    })
    expect(ConsentDetails.appNameOf({ ...unseen, clientName: '' })).toBe(
      'https://new.example.com/client'
    )
  })
})

describe('ConsentApproval', () => {
  it('should take the approvals the host decodes, and refuse an unknown kind', () => {
    // Act
    const approvals = golden.consentApprovals.map((approval) =>
      Schema.decodeUnknownEither(ConsentApproval.Schema)(approval)
    )
    const unknownKind = Schema.decodeUnknownEither(ConsentApproval.Schema)({
      kind: 'password',
      approvedScopes: [],
    })

    // Assert
    expect(approvals.map(Either.isRight)).toEqual([true, true])
    expect(Either.isLeft(unknownKind)).toBe(true)
  })

  it('should approve a device or an app as the host decodes it', () => {
    // Arrange
    const device = decodeDetails(golden.consentDetails.device)
    const app = decodeDetails(golden.consentDetails.oauthRegistered)
    if (device.kind !== 'device' || app.kind !== 'oauth') throw new Error('golden kinds')

    // Act
    const approvals = [
      ConsentApproval.ofDevice(device, ['system/Observation.rs']),
      ConsentApproval.ofOAuth(app, {
        approvedScopes: ['launch/patient'],
        patient: Option.some('pat-1'),
        acknowledged: true,
      }),
    ]

    // Assert
    expect(approvals).toEqual(golden.consentApprovals)
  })

  it("should acknowledge an app's registration only when it is new or changed", () => {
    // Arrange
    const unseen = decodeDetails(golden.consentDetails.oauthNew)
    if (unseen.kind !== 'oauth') throw new Error('golden kind')

    // Act
    const approval = ConsentApproval.ofOAuth(unseen, {
      approvedScopes: ['openid'],
      patient: Option.none(),
      acknowledged: true,
    })

    // Assert
    expect(approval).toEqual({
      kind: 'oauth',
      id: 'req-2',
      approvedScopes: ['openid'],
      acknowledgedRegistration: true,
    })
  })
})

describe('ApprovalOutcome', () => {
  it('should decode each outcome, only an approval granting anything', () => {
    // Act
    const outcomes = golden.approvalOutcomes.map((outcome) =>
      Schema.decodeUnknownSync(ApprovalOutcome.Schema)(outcome)
    )

    // Assert
    expect(outcomes.map(ApprovalOutcome.isApproved)).toEqual([true, false])
  })
})

describe('the consent commands', () => {
  it('should send each command the arguments the host decodes', async () => {
    // Arrange
    const deviceApproval: ConsentApproval.Type = {
      kind: 'device',
      userCode: 'ABCD-EFGH',
      approvedScopes: ['system/Observation.rs'],
    }
    const oauthApproval: ConsentApproval.Type = {
      kind: 'oauth',
      id: 'req-1',
      approvedScopes: ['launch/patient'],
      patient: 'pat-1',
      acknowledgedRegistration: false,
    }

    // Act
    const runs = await Promise.all([
      runAgainstHostAnswering(listPendingConsents, () => Promise.resolve(golden.pendingConsents)),
      runAgainstHostAnswering(
        readConsent({ domain: 'ruth.relay.example.com', consent: DEVICE_KEY }),
        () => Promise.resolve(golden.consentDetails.device)
      ),
      runAgainstHostAnswering(
        approveConsent({ domain: 'ruth.relay.example.com', approval: deviceApproval }),
        () => Promise.resolve(golden.approvalOutcomes[0])
      ),
      runAgainstHostAnswering(
        approveConsent({ domain: 'lab.rathole.example.com', approval: oauthApproval }),
        () => Promise.resolve(golden.approvalOutcomes[1])
      ),
      runAgainstHostAnswering(
        denyConsent({ domain: 'lab.rathole.example.com', consent: OAUTH_KEY }),
        () => Promise.resolve(null)
      ),
    ])

    // Assert
    expect(runs.map((run) => run.seen)).toEqual([
      [{ command: 'pending_consents_list', args: undefined }],
      [
        {
          command: 'server_consent_get',
          args: { domain: 'ruth.relay.example.com', consent: golden.consentKeys[0] },
        },
      ],
      [
        {
          command: 'server_consent_approve',
          args: { domain: 'ruth.relay.example.com', approval: golden.consentApprovals[0] },
        },
      ],
      [
        {
          command: 'server_consent_approve',
          args: { domain: 'lab.rathole.example.com', approval: golden.consentApprovals[1] },
        },
      ],
      [
        {
          command: 'server_consent_deny',
          args: { domain: 'lab.rathole.example.com', consent: golden.consentKeys[1] },
        },
      ],
    ])
    expect(runs.map((run) => run.exit._tag)).toEqual(Array(5).fill('Success'))
    expect(runs[3]?.exit).toEqual(Exit.succeed({ status: 'denied' }))
  })

  it.each(golden.consentErrors)("should fail with the host's $kind refusal", async (error) => {
    // Act
    const { exit } = await runAgainstHostAnswering(
      readConsent({ domain: 'ruth.relay.example.com', consent: OAUTH_KEY }),
      () => Promise.reject(error)
    )

    // Assert
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none()
    const refusal = failure.pipe(
      Option.flatMap((cause) =>
        cause instanceof HostCommandFailed ? cause.refusal : Option.none()
      )
    )
    expect(refusal).toEqual(Option.some(error))
  })
})
