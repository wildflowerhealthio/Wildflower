import { describe, expect, it } from 'vite-plus/test'

import { eventNameForTag, READY_EVENT, READY_TAG } from './event-names.ts'

describe('eventNameForTag', () => {
  // Drift guard: a Rust host pins these same literals in its bridge
  // module (e.g. wildflower's src-tauri `bridge.rs`). Changing any of
  // them is a cross-language protocol break, not a refactor.
  it('should pin the wire literals shared with Rust hosts', () => {
    expect(READY_TAG).toBe('__Ready')
    expect(READY_EVENT).toBe('bridge:__Ready')
    expect(eventNameForTag('AuthTokenIssued')).toBe('bridge:AuthTokenIssued')
    expect(eventNameForTag('Log')).toBe('bridge:Log')
  })
})
