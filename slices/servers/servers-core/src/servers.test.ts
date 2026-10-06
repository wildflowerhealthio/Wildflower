/**
 * The decoders of the base's server commands and `server-status` event,
 * against `slices/servers/servers-wire-golden.json`, the shapes
 * `servers-tauri-rust`'s golden tests serialize to.
 */
import { Cause, DateTime, Effect, Exit, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import golden from '../../servers-wire-golden.json' with { type: 'json' }
import { HostAnswerUndecodable, HostCommandFailed, TauriInvoke } from './host-commands.ts'
import {
  decodeServerStatus,
  listServers,
  removeServer,
  RunPolicy,
  RunPolicyChoice,
  setServerRunPolicy,
  updateServer,
} from './servers.ts'

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

describe('listServers', () => {
  it('should decode the golden listing, deadlines and start times as UTC date-times', async () => {
    // Act
    const { exit, seen } = await runAgainstHostAnswering(listServers, () =>
      Promise.resolve(golden.listedServers)
    )

    // Assert
    expect(seen).toEqual([{ command: 'servers_list', args: undefined }])
    expect(exit).toEqual(
      Exit.succeed([
        {
          domain: 'ruth.relay.example.com',
          relay: { kind: 'selfHostedWildflower', baseUrl: 'https://relay.example.com/' },
          tunnelName: 'ruth',
          launcherUrl: 'https://wildflowerhealth.io/app',
          stagingCertificates: false,
          runPolicy: { kind: 'until', at: utc('2026-10-06T17:42:00Z') },
          status: {
            domain: 'ruth.relay.example.com',
            runState: { state: 'running' },
            tunnelLiveness: {
              status: 'verified',
              publicHost: 'ruth.relay.example.com',
              error: null,
            },
            startedAt: utc('2026-10-06T17:00:00Z'),
          },
        },
        {
          domain: 'lab.rathole.example.com',
          relay: { kind: 'rathole' },
          tunnelName: 'lab',
          launcherUrl: 'http://localhost:5200/app',
          stagingCertificates: true,
          runPolicy: { kind: 'off' },
          status: {
            domain: 'lab.rathole.example.com',
            runState: { state: 'stopped', error: "the server's config couldn't be built" },
            tunnelLiveness: null,
            startedAt: null,
          },
        },
      ])
    )
  })

  it('should fail with the host refusal when servers.json is unreadable', async () => {
    // Arrange
    const refusal = {
      kind: 'registry',
      message: "the server registry has format version 2, which this build doesn't read",
    }

    // Act
    const { exit } = await runAgainstHostAnswering(listServers, () => Promise.reject(refusal))

    // Assert
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(HostCommandFailed)
    expect(error?.message).toBe(`the host command servers_list failed: ${refusal.message}`)
  })

  it('should refuse a listing with one undecodable server', async () => {
    // Arrange
    const [ruth, lab] = golden.listedServers
    const listing = [ruth, { ...lab, runPolicy: { kind: 'sometimes' } }]

    // Act
    const { exit } = await runAgainstHostAnswering(listServers, () => Promise.resolve(listing))

    // Assert
    expect(failureOf(exit)).toBeInstanceOf(HostAnswerUndecodable)
  })
})

describe('decodeServerStatus', () => {
  it.each(golden.listedServers.map(({ status }) => [status.domain, status] as const))(
    'should decode the golden status of %s as a server-status payload',
    async (domain, status) => {
      // Act
      const decoded = await Effect.runPromise(decodeServerStatus(status))

      // Assert
      expect(decoded.domain).toBe(domain)
      expect(decoded.runState.state).toBe(status.runState.state)
    }
  )

  it('should refuse a start time that is not a date-time', async () => {
    // Arrange
    const [ruth] = golden.listedServers
    const payload = { ...ruth?.status, startedAt: 'yesterday' }

    // Act
    const exit = await Effect.runPromiseExit(decodeServerStatus(payload))

    // Assert
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('RunPolicy', () => {
  it('should decode every golden policy, a deadline as a UTC date-time', () => {
    // Act
    const decoded = golden.runPolicies.map((policy) => Schema.decodeUnknownSync(RunPolicy)(policy))

    // Assert
    expect(decoded).toEqual([
      { kind: 'off' },
      { kind: 'whileInUse' },
      { kind: 'until', at: utc('2026-10-06T17:42:00Z') },
      { kind: 'always' },
    ])
  })
})

describe('setServerRunPolicy', () => {
  it.each(golden.runPolicyChoices)(
    'should send the golden choice %j under its domain and decode the stored policy',
    async (policy) => {
      // Arrange
      const choice = Schema.decodeUnknownSync(RunPolicyChoice)(policy)

      // Act
      const { exit, seen } = await runAgainstHostAnswering(
        setServerRunPolicy('ruth.relay.example.com', choice),
        () => Promise.resolve({ kind: 'until', at: '2026-10-06T17:42:00Z' })
      )

      // Assert
      expect(seen).toEqual([
        {
          command: 'server_set_run_policy',
          args: { domain: 'ruth.relay.example.com', policy },
        },
      ])
      expect(exit).toEqual(Exit.succeed({ kind: 'until', at: utc('2026-10-06T17:42:00Z') }))
    }
  )

  it('should fail with the message of the host refusal', async () => {
    // Act
    const { exit } = await runAgainstHostAnswering(
      setServerRunPolicy('ruth.relay.example.com', { kind: 'for', seconds: 0 }),
      () => Promise.reject(golden.commandError)
    )

    // Assert
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(HostCommandFailed)
    expect(error instanceof HostCommandFailed ? Option.getOrNull(error.refusal) : null).toEqual(
      golden.commandError
    )
    expect(error?.message).toContain(golden.commandError.message)
  })
})

describe('updateServer', () => {
  it('should send the launcher and the staging flag under the domain', async () => {
    await fc.assert(
      fc.asyncProperty(fc.webUrl(), fc.boolean(), async (launcherUrl, stagingCertificates) => {
        // Act
        const { exit, seen } = await runAgainstHostAnswering(
          updateServer('lab.rathole.example.com', { launcherUrl, stagingCertificates }),
          () => Promise.resolve(null)
        )

        // Assert
        expect(exit).toEqual(Exit.succeed(null))
        expect(seen).toEqual([
          {
            command: 'server_update',
            args: { domain: 'lab.rathole.example.com', launcherUrl, stagingCertificates },
          },
        ])
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

describe('removeServer', () => {
  it('should send the domain', async () => {
    // Act
    const { exit, seen } = await runAgainstHostAnswering(
      removeServer('lab.rathole.example.com'),
      () => Promise.resolve(null)
    )

    // Assert
    expect(exit).toEqual(Exit.succeed(null))
    expect(seen).toEqual([
      { command: 'server_remove', args: { domain: 'lab.rathole.example.com' } },
    ])
  })
})
