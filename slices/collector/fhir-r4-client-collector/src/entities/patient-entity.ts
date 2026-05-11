import { Entity, type Link } from 'collector-core'
import { Either, Schema } from 'effect'
import type { ParseResult } from 'effect'
import { Patient } from 'fhir-r4/resources'

type PatientType = typeof Patient.Schema.Type
type DecodedPatient = typeof Patient.Schema.Type

class PatientEntity extends Entity.RemoteEntity<PatientType> {
  public static readonly name = 'PatientEntity'

  public static isFoundAt(url: string): boolean {
    return /.*:\/\/[^/]*\/Patient\/[^/]+$/.test(url)
  }

  private readonly decode = Schema.decodeEither(Schema.parseJson(Patient.Schema))

  parse(): Either.Either<
    {
      resources: readonly PatientType[]
      links: readonly Link.Any[]
    },
    ParseResult.ParseError
  > {
    return this.decode(this.body).pipe(
      Either.map((patient: DecodedPatient) => {
        if (patient.id !== null) {
          const withId: PatientType = { ...patient, id: patient.id }
          return {
            resources: [withId],
            links: [
              {
                _tag: 'Open' as const,
                href: `/Observation?subject%3APatient=${encodeURIComponent(patient.id)}&code=3141-9%2C8302-2%2C8287-5%2C39156-5&_count=50`,
              },
            ],
          }
        }
        return {
          resources: [],
          links: [],
        }
      })
    )
  }
}

export { PatientEntity }
