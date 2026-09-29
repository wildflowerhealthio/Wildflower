import { DateTime, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { CarebookProfile } from './carebook-profile.ts'
import { carebookTimestampOf } from './carebook-timestamp.ts'
import profileMe from './fixtures/profile-me.json' with { type: 'json' }

const decodeProfile = Schema.decodeUnknownSync(CarebookProfile)
const encodeProfile = Schema.encodeSync(CarebookProfile)

/** A profile as a producer of the dialect writes it: every field, timestamps via `carebookTimestampOf`. */
const producedProfile: typeof CarebookProfile.Encoded = {
  data: {
    identifiers: {
      email: 'avery.chen@example.com',
      uid: 'uid-synthetic-1',
      reportingGuid: '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0',
    },
    names: { firstName: 'Avery', lastName: 'Chen' },
    birthDate: '1979-02-03',
    zipPostalCode: 'M4C 1B5',
    accountState: 'Validated',
    createdOn: carebookTimestampOf(DateTime.unsafeMake('2019-06-01T13:05:09Z')),
    updatedOn: carebookTimestampOf(DateTime.unsafeMake('2024-01-20T21:44:00Z')),
  },
  related: { profiles: [] },
}

describe('CarebookProfile', () => {
  it('decodes a produced profile and encodes it back unchanged', () => {
    const decoded = decodeProfile(producedProfile)
    expect(decoded.data.identifiers.reportingGuid).toStrictEqual(
      Option.some('0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0')
    )
    expect(decoded.data.createdOn).toStrictEqual(Option.some('2019-06-01T13:05:09+00:00'))
    expect(decoded.related).toStrictEqual(Option.some({ profiles: [] }))
    expect(encodeProfile(decoded)).toStrictEqual(producedProfile)
  })

  it('encodes the capture back unchanged', () => {
    expect(encodeProfile(decodeProfile(profileMe))).toStrictEqual(profileMe)
  })

  it('needs only the uid', () => {
    const decoded = decodeProfile({ data: { identifiers: { uid: 'uid-only' } } })
    expect(decoded.data.accountState).toStrictEqual(Option.none())
    expect(decoded.related).toStrictEqual(Option.none())
  })

  it('ignores keys it does not model', () => {
    const decoded = decodeProfile({
      data: { identifiers: { uid: 'uid-1', loyaltyId: 'L-1' }, preferredStore: '4821' },
      related: { profiles: [], dependants: [] },
    })
    expect(decoded.data.identifiers.uid).toBe('uid-1')
  })

  it('keeps a timestamp in another form rather than failing the profile', () => {
    const decoded = decodeProfile({
      data: { identifiers: { uid: 'uid-1' }, createdOn: '2009-10-02T08:27:10.123Z' },
    })
    expect(decoded.data.createdOn).toStrictEqual(Option.some('2009-10-02T08:27:10.123Z'))
  })
})
