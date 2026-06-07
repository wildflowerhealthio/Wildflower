/* oxlint-disable no-console */
import fs from 'node:fs'
import inspector from 'node:inspector/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Schema } from 'effect'
import {
  Observation as StoreObservation,
  Patient as StorePatient,
} from 'emr-core/livestore'
import { describe, test } from 'vite-plus/test'

import { Observation as FhirObservation } from '../src/resources/observation/index.ts'
import { Patient as FhirPatient } from '../src/resources/patient/index.ts'

const MICRO_ITERATIONS = Number(process.env['MICRO_ITERATIONS'] ?? 5000)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROFILE_DIR = path.join(HERE, '..', '.profiles')
const FIXTURE_DIR = path.join(HERE, 'fixtures')

const loadFixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'))

// Realistic fixtures captured from https://r4.smarthealthit.org — see
// profile/fixtures/*.fixture.json. Parsing to JS once at module load matches
// the HTTP server's hot path, where the body is JSON.parse'd before the
// schema sees it.
const rawPatient = loadFixture('patient.fixture.json')
const rawObservation = loadFixture('observation.fixture.json')

// Decode once to obtain the row form used by the encode/validate benches.
const decodedPatient = Schema.decodeUnknownSync(FhirPatient.Schema)(rawPatient)
const decodedObservation = Schema.decodeUnknownSync(FhirObservation.Schema)(rawObservation)

// `Fhir{Resource}.Schema` decodes into `RowSchemaNullableId.Type` (id may be
// null). The commit-path `RowSchema` requires a concrete id, so narrow here.
if (decodedPatient.id === null) {
  throw new Error('patient.fixture.json must include an id for RowSchema benches')
}
if (decodedObservation.id === null) {
  throw new Error('observation.fixture.json must include an id for RowSchema benches')
}

const patientRow: typeof StorePatient.RowSchema.Type = {
  ...decodedPatient,
  id: decodedPatient.id,
}
const observationRow: typeof StoreObservation.RowSchema.Type = {
  ...decodedObservation,
  id: decodedObservation.id,
}

// `events.upsert.schema` is `Struct({ resource: RowSchema })` from
// `upsertEventSchemaFor` in domain-resource-persistence.ts. This is the
// schema LiveStore uses to (en|de)code the payload of `v1.{Resource}Upserted`
// events on commit and on replay.
const patientUpsertPayload: Schema.Schema.Type<typeof StorePatient.events.upsert.schema> = {
  resource: patientRow,
}
const observationUpsertPayload: Schema.Schema.Type<typeof StoreObservation.events.upsert.schema> = {
  resource: observationRow,
}
const patientUpsertEncoded = Schema.encodeSync(StorePatient.events.upsert.schema)(
  patientUpsertPayload
)
const observationUpsertEncoded = Schema.encodeSync(StoreObservation.events.upsert.schema)(
  observationUpsertPayload
)

const runMicrobench = async (
  label: string,
  op: () => void,
  profileSuffix: string
): Promise<void> => {
  fs.mkdirSync(PROFILE_DIR, { recursive: true })

  // Warm: one untimed call to fill any first-call cache.
  op()

  const session = new inspector.Session()
  session.connect()
  await session.post('Profiler.enable')
  await session.post('Profiler.start')

  const start = performance.now()
  for (let i = 0; i < MICRO_ITERATIONS; i += 1) {
    op()
  }
  const ms = performance.now() - start

  const stopResult = await session.post('Profiler.stop')
  await session.post('Profiler.disable')
  session.disconnect()
  const outPath = path.join(
    PROFILE_DIR,
    `microbench-${profileSuffix}-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`
  )
  fs.writeFileSync(outPath, JSON.stringify(stopResult.profile))
  console.log(
    `[micro:${label}] iterations=${MICRO_ITERATIONS} elapsed=${ms.toFixed(0)}ms per=${(ms / MICRO_ITERATIONS).toFixed(4)}ms`
  )
  console.log(`[micro:${label}] cpuprofile written to ${outPath}`)
}

describe('Microbench: realistic Patient (SMART Health IT fixture)', () => {
  test(`validateSync(StorePatient.RowSchema) ×${MICRO_ITERATIONS}`, async () => {
    const validate = Schema.validateSync(StorePatient.RowSchema)
    await runMicrobench(
      'validate-patient-row',
      () => void validate(patientRow),
      'validate-patient-row'
    )
  })

  test(`encodeSync(StorePatient.RowSchema) ×${MICRO_ITERATIONS} — commit hot path`, async () => {
    const encode = Schema.encodeSync(StorePatient.RowSchema)
    await runMicrobench(
      'encode-patient-row',
      () => void encode(patientRow),
      'encode-patient-row'
    )
  })

  test(`encodeSync(FhirPatient.Schema) ×${MICRO_ITERATIONS} — HTTP response hot path`, async () => {
    const encode = Schema.encodeSync(FhirPatient.Schema)
    await runMicrobench(
      'encode-patient-fhir',
      () => void encode(patientRow),
      'encode-patient-fhir'
    )
  })

  test(`decodeUnknownSync(FhirPatient.Schema) ×${MICRO_ITERATIONS} — HTTP request hot path`, async () => {
    const decode = Schema.decodeUnknownSync(FhirPatient.Schema)
    await runMicrobench(
      'decode-patient-fhir',
      () => void decode(rawPatient),
      'decode-patient-fhir'
    )
  })
})

describe('Microbench: realistic Observation (SMART Health IT fixture)', () => {
  test(`validateSync(StoreObservation.RowSchema) ×${MICRO_ITERATIONS}`, async () => {
    const validate = Schema.validateSync(StoreObservation.RowSchema)
    await runMicrobench(
      'validate-observation-row',
      () => void validate(observationRow),
      'validate-observation-row'
    )
  })

  test(`encodeSync(StoreObservation.RowSchema) ×${MICRO_ITERATIONS} — commit hot path`, async () => {
    const encode = Schema.encodeSync(StoreObservation.RowSchema)
    await runMicrobench(
      'encode-observation-row',
      () => void encode(observationRow),
      'encode-observation-row'
    )
  })

  test(`encodeSync(FhirObservation.Schema) ×${MICRO_ITERATIONS} — HTTP response hot path`, async () => {
    const encode = Schema.encodeSync(FhirObservation.Schema)
    await runMicrobench(
      'encode-observation-fhir',
      () => void encode(observationRow),
      'encode-observation-fhir'
    )
  })

  test(`decodeUnknownSync(FhirObservation.Schema) ×${MICRO_ITERATIONS} — HTTP request hot path`, async () => {
    const decode = Schema.decodeUnknownSync(FhirObservation.Schema)
    await runMicrobench(
      'decode-observation-fhir',
      () => void decode(rawObservation),
      'decode-observation-fhir'
    )
  })
})

describe('Microbench: Patient v1.PatientUpserted event payload', () => {
  test(`validateSync(StorePatient.events.upsert.schema) ×${MICRO_ITERATIONS}`, async () => {
    const validate = Schema.validateSync(StorePatient.events.upsert.schema)
    await runMicrobench(
      'validate-patient-upsert',
      () => void validate(patientUpsertPayload),
      'validate-patient-upsert'
    )
  })

  test(`encodeSync(StorePatient.events.upsert.schema) ×${MICRO_ITERATIONS} — commit hot path`, async () => {
    const encode = Schema.encodeSync(StorePatient.events.upsert.schema)
    await runMicrobench(
      'encode-patient-upsert',
      () => void encode(patientUpsertPayload),
      'encode-patient-upsert'
    )
  })

  test(`decodeUnknownSync(StorePatient.events.upsert.schema) ×${MICRO_ITERATIONS} — replay hot path`, async () => {
    const decode = Schema.decodeUnknownSync(StorePatient.events.upsert.schema)
    await runMicrobench(
      'decode-patient-upsert',
      () => void decode(patientUpsertEncoded),
      'decode-patient-upsert'
    )
  })
})

describe('Microbench: Observation v1.ObservationUpserted event payload', () => {
  test(`validateSync(StoreObservation.events.upsert.schema) ×${MICRO_ITERATIONS}`, async () => {
    const validate = Schema.validateSync(StoreObservation.events.upsert.schema)
    await runMicrobench(
      'validate-observation-upsert',
      () => void validate(observationUpsertPayload),
      'validate-observation-upsert'
    )
  })

  test(`encodeSync(StoreObservation.events.upsert.schema) ×${MICRO_ITERATIONS} — commit hot path`, async () => {
    const encode = Schema.encodeSync(StoreObservation.events.upsert.schema)
    await runMicrobench(
      'encode-observation-upsert',
      () => void encode(observationUpsertPayload),
      'encode-observation-upsert'
    )
  })

  test(`decodeUnknownSync(StoreObservation.events.upsert.schema) ×${MICRO_ITERATIONS} — replay hot path`, async () => {
    const decode = Schema.decodeUnknownSync(StoreObservation.events.upsert.schema)
    await runMicrobench(
      'decode-observation-upsert',
      () => void decode(observationUpsertEncoded),
      'decode-observation-upsert'
    )
  })
})
