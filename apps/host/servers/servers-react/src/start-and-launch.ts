import { type ListedServer, launchServer } from '@wildflowerhealthio/servers-core-js'
import { DateTime, Effect, Either, Option } from 'effect'
import { useEffect } from 'react'

import { failureText } from './failure-text.ts'
import { unreachableGraceEndOf, unreachableSinceOf, waitOutcomeOf } from './launch-wait.ts'
import {
  type PendingLaunch,
  type PendingLaunches,
  usePendingLaunch,
  type WaitingLaunch,
} from './pending-launches.ts'
import { type RunHostCommand, usePendingLaunches, useRunHostCommand } from './router-context.ts'
import { useHasPassed } from './use-has-passed.ts'
import { useOnline } from './use-online.ts'

/**
 * While the server `server`'s start-and-launch is waiting, launch it once its
 * status is launchable and the webview is online, or end the wait once
 * waiting can't help (see `waitOutcomeOf`): with its failure when it has
 * one, or else with none, leaving the server's status or Launch's reason to
 * say why. The launch's outcome ends it too, unless it was cancelled
 * meanwhile.
 *
 * @remarks
 * It keeps the wait's `unreachableSince` current from each status, and looks
 * again when `unreachableGraceHasPassed` turns true at the end of that
 * grace: the host sends a status only when it changes, so a server still
 * unreachable sends none then.
 */
const useDriveStartAndLaunch = (
  server: ListedServer.Type,
  online: boolean,
  unreachableGraceHasPassed: boolean,
  pendingLaunches: PendingLaunches,
  runHostCommand: RunHostCommand
): void => {
  // The store's own object, which changes only when the launch does.
  const pending = Option.getOrUndefined(usePendingLaunch(pendingLaunches, server.domain))
  const { domain, status } = server
  useEffect(() => {
    if (pending?.kind !== 'waiting') return
    const unreachableSince = unreachableSinceOf(
      status,
      pending.unreachableSince,
      DateTime.unsafeNow()
    )
    if (Option.isSome(unreachableSince) !== Option.isSome(pending.unreachableSince)) {
      pendingLaunches.set(domain, Option.some({ ...pending, unreachableSince }))
      return
    }
    const outcome = waitOutcomeOf(status, pending.confirmedAt, unreachableGraceHasPassed)
    if (outcome.kind === 'gaveUp') {
      pendingLaunches.set(
        domain,
        Option.map(outcome.failure, (failure) => ({ kind: 'failed', failure }))
      )
      return
    }
    if (outcome.kind !== 'launchable' || !online) return
    pendingLaunches.set(domain, Option.some({ kind: 'launching' }))
    const settle = (failure: Option.Option<string>): void => {
      // A wait cancelled while it launched stays cancelled.
      if (pendingLaunches.snapshotOf(domain)?.kind !== 'launching') return
      pendingLaunches.set(
        domain,
        Option.map(failure, (text) => ({ kind: 'failed', failure: text }))
      )
    }
    void runHostCommand(Effect.either(launchServer({ domain }))).then(
      (launched) => {
        settle(
          Either.match(launched, {
            onLeft: (error) => Option.some(failureText(error)),
            onRight: () => Option.none(),
          })
        )
      },
      (defect: unknown) => {
        settle(Option.some(`Launching failed: ${String(defect)}`))
      }
    )
  }, [pending, status, online, domain, pendingLaunches, runHostCommand, unreachableGraceHasPassed])
}

/** Where a server's start-and-launch stands, as {@link useStartAndLaunch} drives it. */
interface StartAndLaunch {
  /** The server's start-and-launch in the router context's `pendingLaunches`, if any. */
  readonly pending: Option.Option<PendingLaunch>
  /**
   * Whether a waiting start-and-launch's server has been unreachable with a
   * valid certificate for the whole grace (see `unreachableGraceEndOf`).
   */
  readonly unreachableGraceHasPassed: boolean
}

/**
 * `server`'s start-and-launch, driven while the caller is mounted (see
 * {@link useDriveStartAndLaunch}): by its card's Launch, and by its page,
 * which has no Launch of its own, so a wait begun on the card carries on
 * while the page is open.
 */
const useStartAndLaunch = (server: ListedServer.Type): StartAndLaunch => {
  const online = useOnline()
  const pendingLaunches = usePendingLaunches()
  const pending = usePendingLaunch(pendingLaunches, server.domain)
  const unreachableGraceHasPassed = useHasPassed(
    pending.pipe(
      Option.filter((launching): launching is WaitingLaunch => launching.kind === 'waiting'),
      Option.flatMap(({ unreachableSince }) => unreachableGraceEndOf(unreachableSince))
    )
  )
  useDriveStartAndLaunch(
    server,
    online,
    unreachableGraceHasPassed,
    pendingLaunches,
    useRunHostCommand()
  )
  return { pending, unreachableGraceHasPassed }
}

export { useStartAndLaunch, type StartAndLaunch }
