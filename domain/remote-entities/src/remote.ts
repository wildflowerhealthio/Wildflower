import { MutableHashMap, Option } from 'effect'
import type { ReadonlyRecord } from 'effect/Record'
import type { RemoteEntity, RemoteEntityConstructor } from './entity.ts'
import { RemoteResponse } from './response.ts'
import type * as Source from './source.ts'

abstract class Remote<TResources> {
  public abstract readonly firstPage: Source.Any
  public abstract readonly name: string
  protected abstract readonly remoteEntityConstructors: readonly RemoteEntityConstructor<TResources>[]

  #inProgressResponses = MutableHashMap.empty<string, RemoteResponse>()

  public constructor(
    protected readonly handleEntityReceived: (entity: RemoteEntity<TResources>) => void
  ) {}

  public shouldKeepResponse(event: {
    id: string
    url: string
    status: number
    statusText: string
    headers: ReadonlyRecord<string, string>
  }): boolean {
    if (!this.remoteEntityConstructors.some((constructor) => constructor.isFoundAt(event.url))) {
      return false
    }

    MutableHashMap.set(
      event.id,
      new RemoteResponse(event.url, event.status, event.statusText, event.headers)
    )(this.#inProgressResponses)

    return true
  }

  public handleResponseData(event: { id: string; data: Uint8Array }): void {
    const maybeResponse = MutableHashMap.get(event.id)(this.#inProgressResponses)
    if (maybeResponse._tag === 'None') {
      throw new Error('Received response data for response that is not being tracked')
    }
    maybeResponse.value.appendChunk(event.data)
  }

  public handleResponseFinished(event: { id: string }): void {
    const maybeResponse = MutableHashMap.get(event.id)(this.#inProgressResponses)

    const response = Option.getOrThrow(maybeResponse)

    MutableHashMap.remove(this.#inProgressResponses, event.id)
    const body = response.text()

    const RemoteEntity = this.remoteEntityConstructors.find((Entity) =>
      Entity.isFoundAt(response.url)
    )
    if (RemoteEntity === undefined) return

    const entity = new RemoteEntity({
      body,
      contentType: response.headers['content-type'] ?? '',
      url: response.url,
    })

    this.handleEntityReceived(entity)
  }
}

export { Remote }
