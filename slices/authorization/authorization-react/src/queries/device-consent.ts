import { type UseMutationOptions } from '@tanstack/react-query'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import { Devices } from '@wildflowerhealthio/authorization-core/http-api-definition'
import { Data, Effect, Schema } from 'effect'

import type { RunAuthed } from '../router-context.ts'

type DeviceConsent = Schema.Schema.Type<typeof Devices.DeviceConsentSchema>
type DeviceConsentResult = Schema.Schema.Type<typeof Devices.DeviceConsentResultSchema>
type DeviceConsentNotFound = Schema.Schema.Type<typeof Devices.DeviceConsentNotFoundSchema>

const isDeviceConsentNotFound = Schema.is(Devices.DeviceConsentNotFoundSchema)

/**
 * A device request that is no longer pending when the Owner decides it: it
 * expired (the server enforces its TTL at read time, so it reads as not found)
 * or was decided elsewhere. Its `message` tells the Owner the way out.
 */
class ExpiredDeviceConsent extends Data.TaggedError('ExpiredDeviceConsent')<{
  readonly userCode: string
}> {
  override get message(): string {
    return 'This device request has expired or was already decided. Start pairing again on the device to get a new code.'
  }
}

/**
 * Fold a decision's `404 DeviceConsentNotFound` into {@link ExpiredDeviceConsent},
 * so a card left open past the request's deadline shows copy with the way out
 * rather than the raw not-found body. Exported as the mutation's testable seam;
 * other failures pass through untouched.
 */
const foldExpiredDeviceConsent = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | ExpiredDeviceConsent, R> =>
  Effect.catchIf(
    effect,
    (error): error is E & DeviceConsentNotFound => isDeviceConsentNotFound(error),
    (notFound) => Effect.fail(new ExpiredDeviceConsent({ userCode: notFound.userCode }))
  )

/** The Owner's decision on a device consent: approve with the granted scopes, or deny. */
type DeviceConsentDecision =
  | {
      readonly kind: 'approve'
      readonly userCode: string
      readonly approvedScopes: readonly string[]
      /** An adjusted device name (settings approver renaming the device); omitted keeps the stored one. */
      readonly deviceName?: string
      /** The launch patient a one-patient grant is bound to (JWT `patient` claim); omitted for all-patients. */
      readonly patient?: string
    }
  | { readonly kind: 'deny'; readonly userCode: string }

/**
 * `ApproveDeviceConsent` / `DenyDeviceConsent` over `runAuthed`, as mutation
 * options: the decision's `mutationFn`, which resolves to the resulting
 * decision. The authorization server's device page (`authorization-server-web`)
 * runs it on the browser session.
 */
const deviceConsentMutationOptions = (
  runAuthed: RunAuthed
): UseMutationOptions<DeviceConsentResult, Error, DeviceConsentDecision> => ({
  mutationFn: (decision) =>
    runAuthed(
      Effect.flatMap(AuthorizationServerHttpApiClient, (c) =>
        decision.kind === 'approve'
          ? c.devices.ApproveDeviceConsent({
              path: { userCode: decision.userCode },
              payload: {
                approvedScopes: [...decision.approvedScopes],
                ...(decision.deviceName === undefined ? {} : { deviceName: decision.deviceName }),
                ...(decision.patient === undefined ? {} : { patient: decision.patient }),
              },
            })
          : c.devices.DenyDeviceConsent({ path: { userCode: decision.userCode } })
      ).pipe(foldExpiredDeviceConsent)
    ),
})

export { ExpiredDeviceConsent, foldExpiredDeviceConsent, deviceConsentMutationOptions }
export type { DeviceConsent, DeviceConsentDecision, DeviceConsentResult }
