import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vite-plus/test'
import { CLIENT_BASE_URL_PARAM } from './client-base-url.ts'

// The server reads the parameter under the name `client_base_url.rs` spells.
// Rust can't import it, so this reads the Rust source and holds both sides to
// one value.
describe('CLIENT_BASE_URL_PARAM', () => {
  it('should be spelled the way gatekeeper-rust reads it', () => {
    // Arrange
    const source = readFileSync(
      new URL('../../gatekeeper-rust/src/domain/client_base_url.rs', import.meta.url),
      'utf8'
    )

    // Act
    const rustParam = /const CLIENT_BASE_URL_PARAM: &str = "([^"]*)";/.exec(source)?.[1]

    // Assert
    expect(rustParam).toBe(CLIENT_BASE_URL_PARAM)
  })
})
