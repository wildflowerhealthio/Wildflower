import { describe, expect, test } from 'vite-plus/test'

import { homePathFor } from './home-path.ts'
import { ServerKind } from './server-kind.ts'

describe('homePathFor', () => {
  test('lands a Wildflower server’s session on the apps home', () => {
    expect(homePathFor(ServerKind.Wildflower())).toBe('/home')
  })

  test('lands a plain SMART server’s session on its own home', () => {
    const plainSmart = ServerKind.PlainSmart({
      fhirBaseUrl: 'https://launcher.smarthealthit.org/v/r4/fhir',
      patient: undefined,
    })

    expect(homePathFor(plainSmart)).toBe('/fhir-home')
  })
})
