import type { Either, ParseResult } from 'effect'
import type * as Link from './link.ts'

interface RemoteEntityInit {
  readonly body: string
  readonly contentType: string
  readonly url: string
}

interface RemoteEntityConstructor<out TResources> {
  readonly name: string
  isFoundAt(url: string): boolean
  new (init: RemoteEntityInit): RemoteEntity<TResources>
}

abstract class RemoteEntity<out TResources> {
  public readonly body: string
  public readonly contentType: string
  public readonly url: string

  constructor(init: RemoteEntityInit) {
    this.body = init.body
    this.contentType = init.contentType
    this.url = init.url
  }

  abstract parse(): Either.Either<
    {
      resources: readonly TResources[]
      links: readonly Link.Any[]
    },
    ParseResult.ParseError
  >
}

export type { RemoteEntityInit, RemoteEntityConstructor }
export { RemoteEntity }
