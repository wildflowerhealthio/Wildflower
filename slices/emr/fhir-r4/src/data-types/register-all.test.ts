import { Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

// This MUST be the only registration-bearing import in the file. The whole
// point of the test is to prove that importing `register-all.ts` *alone* runs
// every registrable datatype module's `registerDatatypeSchema(...)`. Importing
// anything else that transitively registers (e.g. `../index.ts`, or a resource)
// would mask a barrel that forgot a module — the registry is a per-test-file
// global under Vitest module isolation, so only what this file's graph imports
// gets registered.
import './register-all.ts'
import { baseDatatypes, registeredNames, resolveDatatypeSchema } from './base/datatype-registry.ts'

describe('register-all datatype barrel', () => {
  // #378: a datatype whose module is never imported leaves its registry slot
  // `undefined`, so the matching choice slot fails encode at runtime with
  // `UnregisteredDatatype`. Asserting the whole registry is populated after
  // loading the barrel turns a dropped/forgotten registration into a CI
  // failure. This is exact: every datatype a resource can reference through a
  // choice slot is a `baseDatatypes` key, so no `undefined` slot means none
  // can fail to resolve.
  test('registers every datatype slot in the registry', () => {
    const unregistered = registeredNames.filter((name) => baseDatatypes[name] === undefined)
    expect(unregistered).toEqual([])
  })

  test.each(registeredNames)('%s resolves to a concrete schema', (name) => {
    expect(Effect.runSyncExit(resolveDatatypeSchema(name))._tag).toBe('Success')
  })
})
