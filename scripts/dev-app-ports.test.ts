import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'

import devAppPortsFile from '../slices/apps/dev-app-ports.json' with { type: 'json' }
import type { DevAppId } from '../vite.config.base.ts'
import { devAppIds, devAppPort, devAppPortsPath, devAppServer } from '../vite.config.base.ts'

// Both sides of every assertion below derive from `dev-app-ports.json` — the
// helper through its own import, the expectations through this one. A copied
// literal here would pin the copy and never catch drift.
const { _comment, ...declaredPorts } = devAppPortsFile

const declaredEntries = Object.entries(declaredPorts)

describe('devAppPort', () => {
  it("resolves every id the file declares to that id's port", () => {
    expect(declaredEntries.length).toBeGreaterThan(0)
    fc.assert(
      fc.property(fc.constantFrom(...declaredEntries), ([id, port]) => {
        expect(devAppPort(id)).toBe(port)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('throws for an id the file does not declare, naming the file and the known ids', () => {
    fc.assert(
      fc.property(
        fc.string().filter((id) => !Object.hasOwn(declaredPorts, id)),
        (unknownId) => {
          expect(() => devAppPort(unknownId)).toThrow(devAppPortsPath)
          expect(() => devAppPort(unknownId)).toThrow(devAppIds.join(', '))
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('rejects the `_comment` prose key, which is documentation rather than a port', () => {
    expect(_comment).toBeTypeOf('string')
    expect(() => devAppPort('_comment')).toThrow(devAppPortsPath)
  })
})

describe('devAppIds', () => {
  it("is exactly the file's keys minus `_comment`", () => {
    expect([...devAppIds]).toStrictEqual(Object.keys(declaredPorts))
  })
})

describe('devAppServer', () => {
  it('pins each app to its declared port, always strictly', () => {
    fc.assert(
      fc.property(fc.constantFrom(...devAppIds), (id) => {
        const server = devAppServer(id)
        expect(server.port).toBe(devAppPort(id))
        // `strictPort` is the whole point: a dev server that drifted onto the
        // next free port would leave the "(Dev)" tile launching something else.
        expect(server.strictPort).toBe(true)
        expect(server.host).toBe('0.0.0.0')
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

// `vp check`'s typecheck over this file is what asserts the block below — the
// same gate that makes the helper's `Record<DevAppId, number>` annotation
// reject a non-number port.
describe('the types devAppServer narrows with', () => {
  it('admits exactly the ids the file declares, never a bare string', () => {
    // Widening the parameter back to `string` would move a typo'd id from
    // `vp check` to a dev-server crash, so pin that it is not `string`.
    expectTypeOf<DevAppId>().toEqualTypeOf<keyof typeof declaredPorts>()
    expectTypeOf<Parameters<typeof devAppServer>[0]>().toEqualTypeOf<DevAppId>()
    expectTypeOf<Parameters<typeof devAppServer>[0]>().not.toEqualTypeOf<string>()
  })

  it('reports `strictPort` as the literal `true`, so no config can spread a `false` in', () => {
    expectTypeOf<ReturnType<typeof devAppServer>['strictPort']>().toEqualTypeOf<true>()
    expectTypeOf<ReturnType<typeof devAppServer>['port']>().toEqualTypeOf<number>()
  })
})
