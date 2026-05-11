import { Entity, type Link } from 'collector-core'
import { Either, Schema } from 'effect'
import type { ParseResult } from 'effect'
import { Bundle } from 'fhir-r4/data-types'
import { Observation } from 'fhir-r4/resources'

type ObservationType = typeof Observation.Schema.Type

const ObservationBundle = Bundle.Schema(Observation.Schema)

class ObservationListEntity extends Entity.RemoteEntity<ObservationType> {
  public static readonly name = 'ObservationListEntity'

  public static isFoundAt(url: string): boolean {
    return /.*:\/\/[^/]*\/Observation.*$/.test(url)
  }

  private readonly decode = Schema.decodeEither(Schema.parseJson(ObservationBundle))

  parse(): Either.Either<
    {
      resources: readonly ObservationType[]
      links: readonly Link.Any[]
    },
    ParseResult.ParseError
  > {
    return this.decode(this.body).pipe(
      Either.map((observation) => ({
        resources:
          observation.entry
            ?.map(({ resource }) => resource)
            .filter((o) => Schema.is(Observation.Schema)(o)) ?? [],
        links: [],
      }))
    )
  }
}

export { ObservationListEntity }
