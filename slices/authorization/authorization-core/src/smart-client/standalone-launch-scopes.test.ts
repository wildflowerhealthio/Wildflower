import { describe, expect, it } from 'vite-plus/test'

import {
  STANDALONE_LAUNCH_SCOPES,
  standaloneLaunchScopeParameter,
} from './standalone-launch-scopes.ts'

describe('STANDALONE_LAUNCH_SCOPES', () => {
  it('is the vocabulary the console’s seeded row allows', () => {
    // Pinned against `0007_seed_wildflower_server_docs_client`'s
    // `allowed_scopes`, which `db/clients.rs` asserts on the Rust side.
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
