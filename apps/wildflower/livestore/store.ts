import { unstable_batchedUpdates as batchUpdates } from 'react-native'

import { makePersistedAdapter } from '@livestore/adapter-expo'
import { type ReactApi, useStore } from '@livestore/react'

import { type Store } from '@livestore/livestore'
import { SyncPayload, schema } from './schema'

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
