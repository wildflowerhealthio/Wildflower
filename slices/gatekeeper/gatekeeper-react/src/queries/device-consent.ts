import {
  queryOptions,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationResult,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { Devices } from 'gatekeeper-core/http-api-definition'

import type { RunAuthed } from '../router-context.ts'
import { deviceConsentQueryKey, GRANTS_QUERY_KEY } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

type DeviceConsent = Schema.Schema.Type<typeof Devices.DeviceConsentSchema>
type DeviceConsentResult = Schema.Schema.Type<typeof Devices.DeviceConsentResultSchema>

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
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          c.devices.GetDeviceConsent({ path: { userCode } })
        )
      ),
  })

const useDeviceConsentQuery = (userCode: string): UseSuspenseQueryResult<DeviceConsent, Error> =>
  useSuspenseQuery(deviceConsentQueryOptions(useRunAuthed(), userCode))

/**
 * `ApproveDeviceConsent` / `DenyDeviceConsent`. Returns the resulting
 * decision.
 *
 * On success the consent screen unmounts (`onDone()` navigates to
 * `/settings/gatekeeper`), so invalidating this consent's own detail key
 * would be dead — nothing re-reads it. Instead invalidate the grants list
 * root: an approval mints a new grant, and that's the surface the user
 * lands on.
 */
const useDeviceConsentMutation = (): UseMutationResult<
  DeviceConsentResult,
  Error,
  | {
      readonly kind: 'approve'
      readonly userCode: string
      readonly approvedScopes: readonly string[]
      /** An adjusted device name (settings approver renaming the device); omitted keeps the stored one. */
      readonly deviceName?: string
    }
  | { readonly kind: 'deny'; readonly userCode: string }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (variables) =>
      runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          variables.kind === 'approve'
            ? c.devices.ApproveDeviceConsent({
                path: { userCode: variables.userCode },
                payload: {
                  approvedScopes: [...variables.approvedScopes],
                  ...(variables.deviceName === undefined
                    ? {}
                    : { deviceName: variables.deviceName }),
                },
              })
            : c.devices.DenyDeviceConsent({ path: { userCode: variables.userCode } })
        )
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: GRANTS_QUERY_KEY })
    },
  })
}

export { deviceConsentQueryOptions, useDeviceConsentMutation, useDeviceConsentQuery }
export type { DeviceConsent }
