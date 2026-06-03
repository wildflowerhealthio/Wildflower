/* oxlint-disable no-console */
import fs from 'node:fs'
import inspector from 'node:inspector/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Schema } from 'effect'
import { Patient as StorePatient } from 'emr-core/livestore'
import { describe, test } from 'vite-plus/test'

import { Patient as FhirPatient } from '../src/resources/patient/index.ts'

const MICRO_ITERATIONS = Number(process.env['MICRO_ITERATIONS'] ?? 5000)
const PROFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.profiles')

type PatientRow = typeof StorePatient.RowSchema.Type
type FullPatientRow = PatientRow & { readonly id: string }

const blankMeta: PatientRow['meta'] = {
  versionId: '',
  lastUpdated: null,
  source: '',
  profile: [],
  security: [],
  tag: [],
}

const samplePatient = (id: string): FullPatientRow => ({
  resourceType: 'Patient',
  id,
  meta: blankMeta,
  implicitRules: null,
  language: null,
  active: true,
  address: [],
  birthDate: null,
  communication: [],
  contact: [],
  deceasedBoolean: false,
  deceasedDateTime: null,
  gender: 'female',
  generalPractitioner: [],
  identifier: [],
  link: [],
  managingOrganization: null,
  maritalStatus: null,
  multipleBirthBoolean: false,
  multipleBirthInteger: null,
  name: [
    {
      id: null,
      extension: [],
      family: 'Doe',
      given: ['Jane'],
      use: null,
      text: null,
      prefix: [],
      suffix: [],
      period: null,
    },
  ],
  photo: [],
  telecom: [],
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
})

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

describe('Microbench: validate/encode same Patient row', () => {
  test(`validateSync(StorePatient.RowSchema) ×${MICRO_ITERATIONS}`, async () => {
    const validate = Schema.validateSync(StorePatient.RowSchema)
    const row = samplePatient('mb-1')
    await runMicrobench('validate-row', () => void validate(row), 'validate-row')
  })

  test(`encodeSync(StorePatient.RowSchema) ×${MICRO_ITERATIONS} — the commit hot path`, async () => {
    const encode = Schema.encodeSync(StorePatient.RowSchema)
    const row = samplePatient('mb-1')
    await runMicrobench('encode-row', () => void encode(row), 'encode-row')
  })

  test(`encodeSync(FhirPatient.Schema) ×${MICRO_ITERATIONS} — the HTTP response hot path`, async () => {
    const encode = Schema.encodeSync(FhirPatient.Schema)
    const row = samplePatient('mb-1')
    await runMicrobench('encode-fhir', () => void encode(row), 'encode-fhir')
  })
})
