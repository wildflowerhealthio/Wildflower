import { unstable_batchedUpdates as batchUpdates } from 'react-native'

import { makePersistedAdapter } from '@livestore/adapter-expo'
import { ReactApi, useStore } from '@livestore/react'

import { Store } from '@livestore/livestore'
import { SyncPayload, schema } from 'fhir-r4-livestore/schema'

const adapter = makePersistedAdapter({
  // sync: { backend: syncUrl ? makeWsSync({ url: syncUrl }) : undefined },
  storage: {},
})

export const useAppStore = (): Store<typeof schema, unknown> & ReactApi =>
  useStore({
    storeId: 'wildflower-store',
    schema,
    adapter,
    batchUpdates,
    syncPayloadSchema: SyncPayload,
    syncPayload: { authToken: 'insecure-token-change-me' },
    boot: (_store) => {},
  })
