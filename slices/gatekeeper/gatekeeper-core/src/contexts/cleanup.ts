import type { Store } from '@livestore/livestore'
import { DateTime } from 'effect'
import {
  AuthorizationCodes,
  AuthorizationRequests,
  PinChallenges,
  type schema,
} from '../livestore/index.ts'

type StoreHandle = Store<typeof schema, object>

const cleanupExpiredPinChallenges = (store: StoreHandle): void => {
  const now = DateTime.unsafeNow()
  const expired = store.query(PinChallenges.queries.allExpired$(now))
  for (const row of expired) {
    if (row.status === 'pending') {
      store.commit(PinChallenges.events.pinChallengeExpired({ id: row.id }))
    }
  }
}

const cleanupExpiredAuthorizationRequests = (store: StoreHandle): void => {
  const now = DateTime.unsafeNow()
  const expired = store.query(AuthorizationRequests.queries.allExpired$(now))
  for (const row of expired) {
    if (row.status === 'pending') {
      store.commit(AuthorizationRequests.events.authorizationRequestExpired({ id: row.id }))
    }
  }
}

const cleanupExpiredAuthorizationCodes = (store: StoreHandle): void => {
  const now = DateTime.unsafeNow()
  const expired = store.query(AuthorizationCodes.queries.allExpired$(now))
  for (const row of expired) {
    store.commit(AuthorizationCodes.events.authorizationCodeConsumed({ code: row.code }))
  }
}

export {
  cleanupExpiredPinChallenges,
  cleanupExpiredAuthorizationRequests,
  cleanupExpiredAuthorizationCodes,
}
