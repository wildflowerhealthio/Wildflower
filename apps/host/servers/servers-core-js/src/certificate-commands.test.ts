import { Cause, DateTime, Effect, Exit, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import golden from '../../servers-wire-golden.json' with { type: 'json' }
import {
  forceNewServerCertificate,
  orderServerCertificate,
  readDuplicateCertificateLimit,
} from './certificate-commands.ts'
import * as DuplicateCertificateLimit from './duplicate-certificate-limit.ts'
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

describe('readDuplicateCertificateLimit', () => {
  it("should decode the host's limit with when the oldest leaves the window", async () => {
    // Act
    const { exit, seen } = await runAgainstHostAnswering(
      readDuplicateCertificateLimit({ domain: DOMAIN }),
      () => Promise.resolve(golden.duplicateCertificateLimit.oneBelowTheLimit)
    )

    // Assert
    expect(seen).toEqual([
      { command: 'server_duplicate_certificate_limit', args: { domain: DOMAIN } },
    ])
    expect(exit).toEqual(
      Exit.succeed(
        Option.some({
          allowed: 5,
          used: 4,
          oldestLeavesWindowAt: Option.some(DateTime.unsafeMake('2026-10-20T17:00:00Z')),
        })
      )
    )
  })

  it('should decode a limit with none used as leaving none', async () => {
    const { exit } = await runAgainstHostAnswering(
      readDuplicateCertificateLimit({ domain: DOMAIN }),
      () => Promise.resolve(golden.duplicateCertificateLimit.noneInTheWindow)
    )
    expect(exit).toEqual(
      Exit.succeed(Option.some({ allowed: 5, used: 0, oldestLeavesWindowAt: Option.none() }))
    )
  })

  it('should decode a CA with no limit as none', async () => {
    const { exit } = await runAgainstHostAnswering(
      readDuplicateCertificateLimit({ domain: DOMAIN }),
      () => Promise.resolve(null)
    )
    expect(exit).toEqual(Exit.succeed(Option.none()))
  })
})

describe('DuplicateCertificateLimit', () => {
  const limitUsed = (used: number): DuplicateCertificateLimit.Type => ({
    allowed: 5,
    used,
    oldestLeavesWindowAt: Option.none(),
  })

  it.each([
    [4, false],
    [5, true],
  ])('with %i of 5 used, should say it is used up: %s', (used, usedUp) => {
    expect(DuplicateCertificateLimit.isUsedUp(limitUsed(used))).toBe(usedUp)
  })
})

describe.each([
  ['server_order_certificate', orderServerCertificate],
  ['server_force_new_certificate', forceNewServerCertificate],
] as const)('%s', (command, order) => {
  it('should invoke the command with the domain and answer once the host has', async () => {
    const { exit, seen } = await runAgainstHostAnswering(order({ domain: DOMAIN }), () =>
      Promise.resolve(null)
    )
    expect(seen).toEqual([{ command, args: { domain: DOMAIN } }])
    expect(exit).toEqual(Exit.succeed(null))
  })

  it.each(golden.certificateOrderRequestErrors)(
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
