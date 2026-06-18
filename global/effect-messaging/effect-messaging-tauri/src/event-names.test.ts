import { describe, expect, it } from 'vite-plus/test'

import { BRIDGE_EVENT, READY_TAG } from './event-names.ts'

describe('event-names', () => {
  // Drift guard: a Rust host pins these same literals in its bridge
  // module (e.g. wildflower's src-tauri `bridge.rs`, and
  // browser-sniffer-tauri-rust's `lib.rs`). Changing either is a
  // cross-language protocol break, not a refactor.
  it('pins the wire literals shared with Rust hosts', () => {
    expect(BRIDGE_EVENT).toBe('bridge')
    expect(READY_TAG).toBe('__Ready')
  })
})
