import type { Store } from '@livestore/livestore'
import { DateTime } from 'effect'
import { AuthCodes, PinAuths, type schema } from '../livestore/index.ts'

type StoreHandle = Store<typeof schema, object>

/**
 * Delete all expired PIN auth rows. Intended to be called by consumers at
 * startup so that orphaned `pinAuths` rows from a previous run are pruned
 * before traffic is served.
 */
const cleanupExpiredPinAuths = (store: StoreHandle): void => {
  const now = DateTime.unsafeNow()
  const expired = store.query(PinAuths.queries.allExpired$(now))
  for (const row of expired) {
    store.commit(PinAuths.events.pinAuthDeleted({ id: row.id }))
  }
}

/**
 * Delete all expired auth code rows. Mirror of {@link cleanupExpiredPinAuths}
 * for the OAuth `authCodes` table.
 */
const cleanupExpiredAuthCodes = (store: StoreHandle): void => {
  const now = DateTime.unsafeNow()
  const expired = store.query(AuthCodes.queries.allExpired$(now))
  for (const row of expired) {
    store.commit(AuthCodes.events.authCodeDeleted({ code: row.code }))
  }
}

export { cleanupExpiredPinAuths, cleanupExpiredAuthCodes }
