import { Option } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import * as IdSpace from './id-space.ts'

/**
 * Covers what each id space states about the ids in it: the domain they hash
 * under, whether the source assigned them, the self-reference prefix, and the
 * URI naming the space.
 */

const BASE = 'https://source.example/baseR4'
const SYSTEM = 'https://wildflowerhealth.io/fhir/sid/example-portal'

const fhirServer = IdSpace.FhirServer({ base: BASE })
const sourceSystem = IdSpace.SourceSystem({ system: SYSTEM })

describe('IdSpace', () => {
  for (const { idSpace, hashDomain, isSourceAssigned, selfReferencePrefix, uri } of [
    {
      idSpace: fhirServer,
      hashDomain: BASE,
      isSourceAssigned: true,
      selfReferencePrefix: Option.some(`${BASE}/`),
      uri: `${BASE}/Patient`,
    },
    {
      idSpace: sourceSystem,
      hashDomain: SYSTEM,
      isSourceAssigned: true,
      selfReferencePrefix: Option.none(),
      uri: SYSTEM,
    },
    {
      idSpace: IdSpace.ContentDigest({ within: fhirServer }),
      hashDomain: BASE,
      isSourceAssigned: false,
      selfReferencePrefix: Option.some(`${BASE}/`),
      uri: `${BASE}/Patient`,
    },
    {
      idSpace: IdSpace.ContentDigest({ within: sourceSystem }),
      hashDomain: SYSTEM,
      isSourceAssigned: false,
      selfReferencePrefix: Option.none(),
      uri: SYSTEM,
    },
    {
      idSpace: IdSpace.SourceFile({ system: SYSTEM }),
      hashDomain: SYSTEM,
      isSourceAssigned: false,
      selfReferencePrefix: Option.none(),
      uri: SYSTEM,
    },
  ]) {
    const label = IdSpace.$match(idSpace, {
      FhirServer: () => 'FhirServer',
      SourceSystem: () => 'SourceSystem',
      ContentDigest: ({ within }) => `ContentDigest within ${within._tag}`,
      SourceFile: () => 'SourceFile',
    })

    test(`${label}: states its hash domain, assignment, prefix and URI`, () => {
      expect({
        hashDomain: IdSpace.hashDomainOf(idSpace),
        isSourceAssigned: IdSpace.isSourceAssigned(idSpace),
        selfReferencePrefix: IdSpace.selfReferencePrefixIfFhirServer(idSpace),
        uri: IdSpace.uriOf(idSpace, 'Patient'),
      }).toEqual({ hashDomain, isSourceAssigned, selfReferencePrefix, uri })
    })
  }
})
