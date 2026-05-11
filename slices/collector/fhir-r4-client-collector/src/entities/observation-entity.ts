import { Entity, type Link } from 'collector-core'
import { Either, Schema } from 'effect'
import type { ParseResult } from 'effect'
import { Observation } from 'emr-core/livestore'

type ObservationWithId = typeof Observation.RowSchema.Type

class ObservationEntity extends Entity.RemoteEntity<ObservationWithId> {
  public static readonly name = 'ObservationEntity'

  public static isFoundAt(url: string): boolean {
    return /.*:\/\/[^/]*\/Observation\/[^/]+$/.test(url)
  }

  private readonly decode = Schema.decodeEither(Schema.parseJson(Observation.RowSchema))

  parse(): Either.Either<
    {
      resources: readonly ObservationWithId[]
      links: readonly Link.Any[]
    },
    ParseResult.ParseError
  > {
    return this.decode(this.body).pipe(
      Either.map((observation) => ({
        resources: [observation],
        links: [],
      }))
    )
  }
}

export { ObservationEntity }
