import {
  queryOptions,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationOptions,
  type UseMutationResult,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import { Devices } from '@wildflowerhealthio/authorization-core/http-api-definition'
import { Data, Effect, Schema } from 'effect'

import type { RunAuthed } from '../router-context.ts'
import { deviceConsentQueryKey, GRANTS_QUERY_KEY } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

type DeviceConsent = Schema.Schema.Type<typeof Devices.DeviceConsentSchema>
type DeviceConsentResult = Schema.Schema.Type<typeof Devices.DeviceConsentResultSchema>
type DeviceConsentNotFound = Schema.Schema.Type<typeof Devices.DeviceConsentNotFoundSchema>

const isDeviceConsentNotFound = Schema.is(Devices.DeviceConsentNotFoundSchema)

/** Shared by the route `loader` and {@link useDeviceConsentQuery}. */
const deviceConsentQueryOptions = (
  runAuthed: RunAuthed,
  userCode: string
): UseSuspenseQueryOptions<
  DeviceConsent,
  Error,
  DeviceConsent,
  readonly [string, string, string]
> =>
  queryOptions({
    queryKey: deviceConsentQueryKey(userCode),
    queryFn: () =>
      runAuthed(
        Effect.flatMap(AuthorizationServerHttpApiClient, (c) =>
          c.devices.GetDeviceConsent({ path: { userCode } })
        )
      ),
  })

const useDeviceConsentQuery = (userCode: string): UseSuspenseQueryResult<DeviceConsent, Error> =>
  useSuspenseQuery(deviceConsentQueryOptions(useRunAuthed(), userCode))

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
 * decision. Shared by {@link useDeviceConsentMutation} and the authorization
 * server's device page (`authorization-server-web`), which runs it on the
 * Owner browser's session rather than the router's.
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

/**
 * {@link deviceConsentMutationOptions} on the router's authed runner. Returns
 * the resulting decision.
 *
 * On success the consent screen unmounts (`onDone()` navigates away), so
 * invalidating this consent's own detail key
 * would be dead — nothing re-reads it. Instead invalidate the grants list
 * root: a device approval now upserts a durable device grant (keyed on
 * `(clientId, deviceName)`), which shows in the "Authorized Devices" list —
 * the surface the user lands on.
 */
const useDeviceConsentMutation = (): UseMutationResult<
  DeviceConsentResult,
  Error,
  DeviceConsentDecision
> => {
  const queryClient = useQueryClient()
  return useMutation({
    ...deviceConsentMutationOptions(useRunAuthed()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: GRANTS_QUERY_KEY })
    },
  })
}

export {
  ExpiredDeviceConsent,
  foldExpiredDeviceConsent,
  deviceConsentMutationOptions,
  deviceConsentQueryOptions,
  useDeviceConsentMutation,
  useDeviceConsentQuery,
}
export type { DeviceConsent, DeviceConsentDecision, DeviceConsentResult }
