import { FhirReadFailed, FhirRecords } from '@wildflowerhealthio/assistant-core-js'
import {
  answerJson,
  answerStatus,
  answerText,
  dropRequest,
  STUB_FHIR_BASE,
  stubSmartRuntime,
} from '@wildflowerhealthio/fhir-r4-react/smart/test-helpers'
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
