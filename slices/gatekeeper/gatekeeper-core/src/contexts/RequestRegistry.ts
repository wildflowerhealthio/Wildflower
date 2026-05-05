import type { Store } from '@livestore/livestore'
import { DateTime } from 'effect'
import * as HttpRequests from '../livestore/http-requests.ts'
import type { schema } from '../livestore/index.ts'

type StoreHandle = Store<typeof schema, object>

let currentStore: StoreHandle | null = null
const pendingApprovals = new Map<string, (approved: boolean) => void>()

function setRequestRegistryStore(store: StoreHandle | null): void {
  currentStore = store
}

function registerPendingApproval(id: string, resolve: (approved: boolean) => void): () => void {
  pendingApprovals.set(id, resolve)
  return () => {
    pendingApprovals.delete(id)
  }
}

function resolveApproval(id: string, approved: boolean): void {
  const requestId = HttpRequests.HttpRequestIdSchema.make(id)

  if (currentStore !== null) {
    if (approved) {
      currentStore.commit(HttpRequests.events.httpRequestApproved({ id: requestId }))
    } else {
      currentStore.commit(
        HttpRequests.events.httpRequestRejected({
          id: requestId,
          respondedAt: DateTime.unsafeNow(),
        })
      )
    }
  }

  const resolve = pendingApprovals.get(id)
  if (resolve !== undefined) {
    pendingApprovals.delete(id)
    resolve(approved)
  }
}

function recordResponse(id: string, statusCode: number): void {
  if (currentStore === null) return
  currentStore.commit(
    HttpRequests.events.httpRequestResponded({
      id: HttpRequests.HttpRequestIdSchema.make(id),
      statusCode,
      respondedAt: DateTime.unsafeNow(),
    })
  )
}

export { setRequestRegistryStore, registerPendingApproval, resolveApproval, recordResponse }
export type { StoreHandle }
