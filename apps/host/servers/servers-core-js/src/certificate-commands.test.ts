import { Cause, DateTime, Effect, Exit, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import golden from '../../servers-wire-golden.json' with { type: 'json' }
import {
  getServerCertificate,
  orderNewServerCertificate,
  readDuplicateCertificates,
} from './certificate-commands.ts'
import * as DuplicateCertificates from './duplicate-certificates.ts'
import { HostCommandFailed, TauriInvoke } from './host-commands.ts'

const DOMAIN = 'ruth.relay.example.com'

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

describe('readDuplicateCertificates', () => {
  it("should decode the host's count with when the oldest leaves the window", async () => {
    // Act
    const { exit, seen } = await runAgainstHostAnswering(
      readDuplicateCertificates({ domain: DOMAIN }),
      () => Promise.resolve(golden.duplicateCertificates.oneBelowTheLimit)
    )

    // Assert
    expect(seen).toEqual([{ command: 'server_duplicate_certificates', args: { domain: DOMAIN } }])
    expect(exit).toEqual(
      Exit.succeed(
        Option.some({
          limit: 5,
          count: 4,
          oldestLeavesWindowAt: Option.some(DateTime.unsafeMake('2026-10-20T17:00:00Z')),
        })
      )
    )
  })

  it('should decode a count with none in the window as leaving none', async () => {
    const { exit } = await runAgainstHostAnswering(
      readDuplicateCertificates({ domain: DOMAIN }),
      () => Promise.resolve(golden.duplicateCertificates.noneInTheWindow)
    )
    expect(exit).toEqual(
      Exit.succeed(Option.some({ limit: 5, count: 0, oldestLeavesWindowAt: Option.none() }))
    )
  })

  it('should decode a CA with no limit as no count', async () => {
    const { exit } = await runAgainstHostAnswering(
      readDuplicateCertificates({ domain: DOMAIN }),
      () => Promise.resolve(null)
    )
    expect(exit).toEqual(Exit.succeed(Option.none()))
  })
})

describe('DuplicateCertificates', () => {
  const counted = (count: number): DuplicateCertificates.Type => ({
    limit: 5,
    count,
    oldestLeavesWindowAt: Option.none(),
  })

  it.each([
    [3, false, false],
    [4, true, false],
    [5, true, true],
  ])(
    'with %i of 5, should say the next reaches the limit: %s, at the limit: %s',
    (count, nextReaches, atLimit) => {
      expect(DuplicateCertificates.nextReachesLimit(counted(count))).toBe(nextReaches)
      expect(DuplicateCertificates.isAtLimit(counted(count))).toBe(atLimit)
    }
  )
})

describe.each([
  ['server_get_certificate', getServerCertificate],
  ['server_order_new_certificate', orderNewServerCertificate],
] as const)('%s', (command, order) => {
  it('should invoke the command with the domain and answer once the host has', async () => {
    const { exit, seen } = await runAgainstHostAnswering(order({ domain: DOMAIN }), () =>
      Promise.resolve(null)
    )
    expect(seen).toEqual([{ command, args: { domain: DOMAIN } }])
    expect(exit).toEqual(Exit.succeed(null))
  })

  it.each(golden.certificateActionErrors)(
    "should fail with the host's $kind refusal",
    async (error) => {
      // Act
      const { exit } = await runAgainstHostAnswering(order({ domain: DOMAIN }), () =>
        Promise.reject(error)
      )

      // Assert
      const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none()
      const refusal = failure.pipe(
        Option.flatMap((cause) =>
          cause instanceof HostCommandFailed ? cause.refusal : Option.none()
        )
      )
      expect(refusal).toEqual(Option.some(error))
    }
  )
})
