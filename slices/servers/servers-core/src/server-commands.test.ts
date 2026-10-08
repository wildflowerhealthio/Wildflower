import { Cause, DateTime, Effect, Either, Exit, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import golden from '../../servers-wire-golden.json' with { type: 'json' }
import { enableBackgroundSessionRecovery } from './background-session-recovery.ts'
import type * as CertificateState from './certificate-state.ts'
import { HostCommandFailed, TauriInvoke } from './host-commands.ts'
import * as ListedServer from './listed-server.ts'
import * as RunPolicyChoice from './run-policy-choice.ts'
import * as RunPolicy from './run-policy.ts'
import { listServers, removeServer, setServerRunPolicy, updateServer } from './server-commands.ts'
import * as ServerStatus from './server-status.ts'

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

/** The error `exit` failed with, or `undefined` when it succeeded. */
const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined

const utc = (iso: string): DateTime.Utc => DateTime.unsafeMake(iso)

describe('ServerStatus', () => {
  const decode = (status: unknown): ServerStatus.Type =>
    Schema.decodeUnknownSync(ServerStatus.Schema)(status)

  it('should decode a running status with its start and health', () => {
    // Act
    const status = decode(golden.serverStatuses.runningAndReachable)

    // Assert
    expect(status).toMatchObject({
      runState: 'running',
      runningSince: utc('2026-10-06T17:00:00Z'),
    })
    expect(ServerStatus.healthOf(status)).toEqual(
      Option.some({ kind: 'reachable', status: 'pass' })
    )
    expect(ServerStatus.lastStopOf(status)).toEqual(Option.none())
  })

  it('should decode a starting status with no health yet', () => {
    const status = decode(golden.serverStatuses.startingUnchecked)
    expect(status.runState).toBe('starting')
    expect(ServerStatus.healthOf(status)).toEqual(Option.none())
  })

  it("should decode a running server's unreachable health with its error", () => {
    const status = decode(golden.serverStatuses.runningUnreachable)
    expect(ServerStatus.healthOf(status)).toEqual(
      Option.some({ kind: 'unreachable', error: 'the relay answered 502' })
    )
  })

  it('should decode a server that never ran as stopped with no last stop', () => {
    const status = decode(golden.serverStatuses.neverRun)
    expect(status.runState).toBe('stopped')
    expect(ServerStatus.lastStopOf(status)).toEqual(Option.none())
  })

  it('should decode a failed run with its error', () => {
    const status = decode(golden.serverStatuses.stoppedWithAnError)
    expect(ServerStatus.lastStopOf(status)).toEqual(
      Option.some({
        reason: 'endedOnItsOwn',
        platformReason: Option.none(),
        error: Option.some("the server's config couldn't be built"),
        stoppedAt: utc('2026-10-06T17:03:00Z'),
      })
    )
  })

  it("should decode the platform's reason for a stop the platform made", () => {
    const status = decode(golden.serverStatuses.stoppedByThePlatform)
    expect(
      ServerStatus.lastStopOf(status).pipe(Option.flatMap((stop) => stop.platformReason))
    ).toEqual(Option.some('platformTimeout'))
  })

  it('should decode a run stopped by its policy ending', () => {
    const status = decode(golden.serverStatuses.stoppedAsItsPolicyEnded)
    expect(ServerStatus.lastStopOf(status).pipe(Option.map((stop) => stop.reason))).toEqual(
      Option.some('policyInactive')
    )
  })

  it('should refuse a running status without its start, and an unknown run state', () => {
    // Arrange
    const { runningSince: _runningSince, ...withoutStart } =
      golden.serverStatuses.runningAndReachable

    // Act
    const decoded = [withoutStart, { domain: 'ruth.relay.example.com', runState: 'paused' }].map(
      (payload) => ServerStatus.decodeEvent(payload)
    )

    // Assert
    for (const either of decoded) expect(Either.isLeft(either)).toBe(true)
  })
})

describe('RunPolicy', () => {
  it('should decode every policy the host stores', () => {
    // Act
    const policies = golden.runPolicies.map((policy) =>
      Schema.decodeUnknownSync(RunPolicy.Schema)(policy)
    )

    // Assert
    expect(policies.map((policy) => policy.kind)).toEqual(['off', 'whileOpen', 'until', 'always'])
    expect(RunPolicy.deadlineOf(policies[2])).toEqual(Option.some(utc('2026-10-06T17:42:00Z')))
  })

  it('should say an until has ended at and after its deadline only', () => {
    // Arrange
    const until = Schema.decodeUnknownSync(RunPolicy.Schema)(golden.runPolicies[2])

    // Act / Assert
    expect(RunPolicy.hasEndedAt(until, utc('2026-10-06T17:41:59Z'))).toBe(false)
    expect(RunPolicy.hasEndedAt(until, utc('2026-10-06T17:42:00Z'))).toBe(true)
    expect(RunPolicy.hasEndedAt({ kind: 'always' }, utc('2026-10-06T17:42:00Z'))).toBe(false)
  })

  it('should refuse the old whileInUse kind', () => {
    expect(Schema.decodeUnknownOption(RunPolicy.Schema)({ kind: 'whileInUse' })).toEqual(
      Option.none()
    )
  })
})

describe('RunPolicyChoice', () => {
  it('should decode every choice the host takes, and refuse a duration of zero', () => {
    // Act
    const choices = golden.runPolicyChoices.map((choice) =>
      Schema.decodeUnknownSync(RunPolicyChoice.Schema)(choice)
    )

    // Assert
    expect(choices).toEqual(golden.runPolicyChoices)
    expect(Schema.decodeUnknownOption(RunPolicyChoice.Schema)({ kind: 'for', seconds: 0 })).toEqual(
      Option.none()
    )
  })
})

describe('listServers', () => {
  it('should invoke servers_list and decode each listed server', async () => {
    // Act
    const { exit, seen } = await runAgainstHostAnswering(listServers, () =>
      Promise.resolve(golden.listedServers)
    )

    // Assert
    expect(seen).toEqual([{ command: 'servers_list', args: undefined }])
    expect(Exit.isSuccess(exit)).toBe(true)
    const servers = Exit.isSuccess(exit) ? exit.value : []
    expect(servers.map((server) => server.domain)).toEqual([
      'ruth.relay.example.com',
      'lab.rathole.example.com',
    ])
    expect(servers[1]?.status.runState).toBe('stopped')
    expect(servers[0]?.relay).toEqual({
      kind: 'selfHostedWildflower',
      baseUrl: 'https://relay.example.com/',
    })
  })

  it("should fail with the host's refusal when servers.json can't be read", async () => {
    // Act
    const { exit } = await runAgainstHostAnswering(listServers, () =>
      Promise.reject(golden.commandErrors[1])
    )

    // Assert
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(HostCommandFailed)
    const refusal = error instanceof HostCommandFailed ? error.refusal : Option.none()
    expect(refusal).toEqual(Option.some(golden.commandErrors[1]))
  })
})

describe('the server commands', () => {
  it('should send each command its camelCase arguments', async () => {
    // Act
    const runs = await Promise.all([
      runAgainstHostAnswering(
        setServerRunPolicy({
          domain: 'ruth.relay.example.com',
          choice: { kind: 'for', seconds: 1800 },
        }),
        () => Promise.resolve(golden.runPolicies[2])
      ),
      runAgainstHostAnswering(
        updateServer({
          domain: 'ruth.relay.example.com',
          launcherUrl: 'http://localhost:5200/app',
          certificateAuthority: 'letsEncryptStaging',
        }),
        () => Promise.resolve(null)
      ),
      runAgainstHostAnswering(removeServer({ domain: 'ruth.relay.example.com' }), () =>
        Promise.resolve(null)
      ),
      runAgainstHostAnswering(
        enableBackgroundSessionRecovery({
          serviceLabel: 'Wildflower server is running',
          foregroundServiceType: 'specialUse',
        }),
        () => Promise.resolve(null)
      ),
    ])

    // Assert
    expect(runs.map((run) => run.seen)).toEqual([
      [
        {
          command: 'server_set_run_policy',
          args: { domain: 'ruth.relay.example.com', choice: { kind: 'for', seconds: 1800 } },
        },
      ],
      [
        {
          command: 'server_update',
          args: {
            domain: 'ruth.relay.example.com',
            launcherUrl: 'http://localhost:5200/app',
            certificateAuthority: 'letsEncryptStaging',
          },
        },
      ],
      [{ command: 'server_remove', args: { domain: 'ruth.relay.example.com' } }],
      [
        {
          command: 'plugin:background-service|configure_recovery',
          args: {
            enabled: true,
            config: {
              serviceLabel: 'Wildflower server is running',
              foregroundServiceType: 'specialUse',
            },
          },
        },
      ],
    ])
    expect(runs[0]?.exit).toEqual(Exit.succeed({ kind: 'until', at: utc('2026-10-06T17:42:00Z') }))
  })
})

describe('ListedServer', () => {
  it("should replace a listed server's status with a newer one", () => {
    // Arrange
    const [ruth] = Schema.decodeUnknownSync(Schema.Array(ListedServer.Schema))(golden.listedServers)
    const stopped = Schema.decodeUnknownSync(ServerStatus.Schema)(
      golden.serverStatuses.stoppedWithAnError
    )

    // Act
    const updated = ListedServer.withStatus(ruth, stopped)

    // Assert
    expect(updated.status).toBe(stopped)
    expect(updated.runPolicy).toBe(ruth.runPolicy)
    expect(updated.certificate).toBe(ruth.certificate)
  })

  it("should take a run's certificate state from a newer status", () => {
    // Arrange
    const [ruth] = Schema.decodeUnknownSync(Schema.Array(ListedServer.Schema))(golden.listedServers)
    const renewalFailed = Schema.decodeUnknownSync(ServerStatus.Schema)(
      golden.serverStatuses.runningRenewalFailed
    )

    // Act
    const updated = ListedServer.withStatus(ruth, renewalFailed)

    // Assert
    expect(updated.certificate.status).toBe('renewalDue')
  })

  it("should decode a stopped server's lapsed certificate as expired", () => {
    // Act
    const [, lab] = Schema.decodeUnknownSync(Schema.Array(ListedServer.Schema))(
      golden.listedServers
    )

    // Assert
    expect(lab.certificate.status).toBe('expired')
    expect(lab.certificate.issuer).toBe('letsEncryptStaging')
    expect(lab.certificate.lastError).toEqual(Option.none())
  })
})

describe('CertificateState', () => {
  const certificateOf = (status: unknown): Option.Option<CertificateState.Type> =>
    ServerStatus.certificateOf(Schema.decodeUnknownSync(ServerStatus.Schema)(status))

  it("should decode a run's valid certificate with its validity and fingerprint", () => {
    // Act
    const certificate = certificateOf(golden.serverStatuses.runningAndReachable)

    // Assert
    expect(certificate).toEqual(
      Option.some({
        status: 'valid',
        issuer: 'letsEncrypt',
        issued: Option.some({
          notBefore: utc('2026-10-01T00:00:00Z'),
          notAfter: utc('2026-12-30T00:00:00Z'),
          fingerprint: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        }),
        lastError: Option.none(),
      })
    )
  })

  it('should decode a rate limit with when to retry, and a failed challenge with its detail', () => {
    // Act
    const rateLimited = certificateOf(golden.serverStatuses.runningUnreachable)
    const challengeFailed = certificateOf(golden.serverStatuses.runningRenewalFailed)

    // Assert
    expect(rateLimited.pipe(Option.flatMap((state) => state.lastError))).toEqual(
      Option.some({ kind: 'rateLimited', retryAfter: Option.some(utc('2026-10-06T17:59:00Z')) })
    )
    expect(rateLimited.pipe(Option.map((state) => state.status))).toEqual(Option.some('failed'))
    expect(challengeFailed.pipe(Option.flatMap((state) => state.lastError))).toEqual(
      Option.some({ kind: 'challengeFailed', detail: Option.some('Connection refused') })
    )
  })

  it('should have no certificate state for a stopped status', () => {
    expect(certificateOf(golden.serverStatuses.stoppedWithAnError)).toEqual(Option.none())
  })
})
