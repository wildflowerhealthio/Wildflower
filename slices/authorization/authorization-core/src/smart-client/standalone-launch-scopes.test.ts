import { describe, expect, it } from 'vite-plus/test'

import {
  STANDALONE_LAUNCH_SCOPES,
  standaloneLaunchScopeParameter,
} from './standalone-launch-scopes.ts'

describe('STANDALONE_LAUNCH_SCOPES', () => {
  it('is the vocabulary both seeded standalone-launch rows allow', () => {
    // Pinned against `0007_seed_wildflower_server_docs_client` and
    // `0012_seed_wildflower_react_client`, which register identical
    // `allowed_scopes` (`db/clients.rs` has the test that keeps them equal).
    // `/oauth/authorize` clamps a request to the row, so a scope added here and
    // not there fails the flow at the endpoint.
    expect([...STANDALONE_LAUNCH_SCOPES]).toEqual([
      'openid',
      'profile',
      'fhirUser',
      'launch',
      'launch/patient',
      'offline_access',
      'wildflower/launch',
      'system/*.cruds',
      'wildflower/*.cruds',
    ])
  })
})

describe('standaloneLaunchScopeParameter', () => {
  it('joins the scopes the way RFC 6749 §3.3 asks for', () => {
    // Act / Assert — single spaces, in order, nothing else.
    expect(standaloneLaunchScopeParameter().split(' ')).toEqual([...STANDALONE_LAUNCH_SCOPES])
  })
})
