import { FhirReadFailed, FhirRecords, FhirWriteFailed } from '@wildflowerhealthio/assistant-core-js'
import {
  answerJson,
  answerStatus,
  answerText,
  dropRequest,
  STUB_FHIR_BASE,
  stubSmartRuntime,
} from '@wildflowerhealthio/fhir-r4-react/smart/test-helpers'
import type { ResourceWrite } from '@wildflowerhealthio/fhir-r4/clients'
import { Effect, Exit, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { fhirRecordsLayerFor } from './fhir-records-layer.ts'

const patient = { resourceType: 'Patient', id: 'p1' }

/** Read `path` through the layer over a stub server answering from `answers`. */
const readThrough = (
  answers: Parameters<typeof stubSmartRuntime>[0],
  path: string
): Promise<Exit.Exit<unknown, FhirReadFailed>> => {
  const { runtime } = stubSmartRuntime(answers)
  return Effect.runPromiseExit(
    Effect.flatMap(FhirRecords, (records) => records.read(path)).pipe(
      Effect.provide(fhirRecordsLayerFor(STUB_FHIR_BASE, runtime.runSmart))
    )
  )
}

describe('fhirRecordsLayerFor', () => {
  it("should read a path under the connection's FHIR base", async () => {
    expect(await readThrough({ 'Patient/p1': answerJson(patient) }, 'Patient/p1')).toEqual(
      Exit.succeed(patient)
    )
  })

  it.each([
    [
      answerStatus(403, {
        resourceType: 'OperationOutcome',
        issue: [{ diagnostics: 'Not in your grant' }],
      }),
      { kind: 'error-status', status: 403, outcomeText: Option.some('Not in your grant') },
    ],
    [dropRequest, { kind: 'unreachable' }],
    [answerText('<html>'), { kind: 'not-json' }],
  ] as const)('should fail a read the server failed as why it failed', async (answer, failure) => {
    expect(await readThrough({ 'Patient/p1': answer }, 'Patient/p1')).toEqual(
      Exit.fail(new FhirReadFailed({ failure }))
    )
  })
})

describe('fhirRecordsLayerFor writes', () => {
  const observation = { resourceType: 'Observation', id: 'o1', status: 'final' } as const

  /** `write` through the layer over a stub server answering from `answers`. */
  const writeThrough = (
    answers: Parameters<typeof stubSmartRuntime>[0],
    write: (
      records: typeof FhirRecords.Service
    ) => Effect.Effect<ResourceWrite.Written, FhirWriteFailed>
  ): Promise<{
    readonly exit: Exit.Exit<ResourceWrite.Written, FhirWriteFailed>
    readonly server: ReturnType<typeof stubSmartRuntime>
  }> => {
    const server = stubSmartRuntime(answers)
    return Effect.runPromiseExit(
      Effect.flatMap(FhirRecords, write).pipe(
        Effect.provide(fhirRecordsLayerFor(STUB_FHIR_BASE, server.runtime.runSmart))
      )
    ).then((exit) => ({ exit, server }))
  }

  it('should create through the connection and succeed with the stored record', async () => {
    const stored = { ...observation, meta: { versionId: '1' } }
    const { exit, server } = await writeThrough(
      { Observation: answerJson(stored, 201) },
      (records) => records.create({ resource: observation })
    )

    expect(exit).toEqual(Exit.succeed({ record: stored, id: 'o1', versionId: Option.some('1') }))
    expect(server.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'POST https://fhir.example/Observation',
    ])
  })

  it('should fail an update whose version is stale as precondition-failed', async () => {
    const { exit, server } = await writeThrough(
      { 'Observation/o1': answerStatus(412) },
      (records) => records.update({ resource: observation, versionId: '2' })
    )

    expect(exit).toEqual(
      Exit.fail(new FhirWriteFailed({ failure: { kind: 'precondition-failed' } }))
    )
    expect(server.requests[0]?.headers['if-match']).toBe('W/"2"')
  })
})
