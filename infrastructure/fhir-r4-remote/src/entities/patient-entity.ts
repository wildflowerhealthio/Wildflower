import { Either, Schema } from 'effect'
import type { ParseResult } from 'effect'
import { Patient } from 'fhir-r4-livestore/resources'
import { Entity, type Link } from 'remote-entities'

class PatientEntity extends Entity.RemoteEntity<typeof Patient.WithId.Type> {
  public static readonly name = 'PatientEntity'

  public static isFoundAt(url: string): boolean {
    return /.*:\/\/[^/]*\/Patient\/[^/]+$/.test(url)
  }

  private readonly decode = Schema.decodeEither(Schema.parseJson(Patient.WithId))

  parse(): Either.Either<
    {
      resources: readonly (typeof Patient.WithId.Type)[]
      links: readonly Link.Any[]
    },
    ParseResult.ParseError
  > {
    return this.decode(this.body).pipe(
      Either.map((patient) => ({
        resources: [patient],
        links: [
          {
            _tag: 'Open' as const,
            href: `/Observation?subject%3APatient=${encodeURIComponent(patient.id)}&code=3141-9%2C8302-2%2C8287-5%2C39156-5&_count=50`,
          },
        ],
      }))
    )
  }
}

export { PatientEntity }
