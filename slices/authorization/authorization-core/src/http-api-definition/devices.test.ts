import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'vite-plus/test'

import { DEVICE_CONSENT_SCOPES } from './devices.ts'

/** The Rust module whose scope functions gate the device routes. */
const CONSENT_SCOPES_SOURCE = new URL(
  '../../../../../apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs',
  import.meta.url
)

/** `scopes-rust`'s `Permission` constants, as the scope string's letter. */
const PERMISSION_LETTERS: Readonly<Record<string, string>> = {
  CREATE: 'c',
  READ: 'r',
  UPDATE: 'u',
  DELETE: 'd',
  SEARCH: 's',
}

/**
 * The `wildflower/…` scope string the Rust function `name` returns, read from
 * its single `Scope::wildflower(WildflowerResource::…, Permission::…)`.
 */
const rustWildflowerScope = (source: string, name: string): string => {
  const body = new RegExp(`fn ${name}\\(\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? ''
  const match = /Scope::wildflower\(\s*WildflowerResource::(\w+),\s*Permission::(\w+),?\s*\)/.exec(
    body
  )
  if (match === null) throw new Error(`no single wildflower scope in ${name}`)
  const [, resource = '', permission = ''] = match
  return `wildflower/${resource}.${PERMISSION_LETTERS[permission] ?? `?${permission}`}`
}

describe('DEVICE_CONSENT_SCOPES', () => {
  test("is the server's reader and decider gates, read from the Rust source", () => {
    const source = readFileSync(CONSENT_SCOPES_SOURCE, 'utf8')

    expect([...DEVICE_CONSENT_SCOPES]).toEqual([
      rustWildflowerScope(source, 'consent_reader_scopes'),
      rustWildflowerScope(source, 'consent_decider_scopes'),
    ])
  })
})
