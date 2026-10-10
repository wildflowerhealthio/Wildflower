import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Cause, Effect, Exit, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { readAppVersion } from './app-version.ts'
import { HostAnswerUndecodable, HostCommandFailed, TauriInvoke } from './host-commands.ts'
import { readNotificationPermission, requestNotificationPermission } from './notifications.ts'

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

/** Any JSON value but `true`, `false` and `null`. */
const notAPermissionGrantedAnswer = fc
  .jsonValue()
  .filter((value) => value !== true && value !== false && value !== null)

describe('readNotificationPermission', () => {
  it.each([
    [true, 'granted'],
    [false, 'denied'],
    [null, 'prompt'],
  ] as const)(
    'should read the plugin answer %j as %s',
    async (pluginAnswer, expectedPermission) => {
      // Act
      const { exit, seen } = await runAgainstHostAnswering(readNotificationPermission, () =>
        Promise.resolve(pluginAnswer)
      )

      // Assert
      expect(exit).toEqual(Exit.succeed(expectedPermission))
      expect(seen).toEqual([
        { command: 'plugin:notification|is_permission_granted', args: undefined },
      ])
    }
  )

  it('should refuse any other answer as undecodable', async () => {
    await fc.assert(
      fc.asyncProperty(notAPermissionGrantedAnswer, async (pluginAnswer) => {
        // Act
        const { exit } = await runAgainstHostAnswering(readNotificationPermission, () =>
          Promise.resolve(pluginAnswer)
        )

        // Assert
        expect(failureOf(exit)).toBeInstanceOf(HostAnswerUndecodable)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('requestNotificationPermission', () => {
  it.each([
    ['granted', 'granted'],
    ['denied', 'denied'],
    ['prompt', 'prompt'],
    ['prompt-with-rationale', 'prompt'],
  ] as const)('should read the plugin answer %s as %s', async (pluginAnswer, expected) => {
    // Act
    const { exit, seen } = await runAgainstHostAnswering(requestNotificationPermission, () =>
      Promise.resolve(pluginAnswer)
    )

    // Assert
    expect(exit).toEqual(Exit.succeed(expected))
    expect(seen).toEqual([{ command: 'plugin:notification|request_permission', args: undefined }])
  })
})

describe('readAppVersion', () => {
  it('should answer the version string the host sends', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (version) => {
        // Act
        const { exit, seen } = await runAgainstHostAnswering(readAppVersion, () =>
          Promise.resolve(version)
        )

        // Assert
        expect(exit).toEqual(Exit.succeed(version))
        expect(seen).toEqual([{ command: 'plugin:app|version', args: undefined }])
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('invokeHostCommand', () => {
  it('should fail with the command and the rejection when the host rejects the invoke', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (rejection) => {
        // Act
        const { exit } = await runAgainstHostAnswering(readAppVersion, () =>
          Promise.reject(rejection)
        )

        // Assert
        expect(exit).toEqual(
          Exit.fail(new HostCommandFailed({ command: 'plugin:app|version', cause: rejection }))
        )
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should name the command in a decode failure', async () => {
    // Act
    const { exit } = await runAgainstHostAnswering(readAppVersion, () => Promise.resolve(7))

    // Assert
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(HostAnswerUndecodable)
    expect(error?.message).toContain('plugin:app|version')
  })
})
