import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parse } from 'acorn'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import { checkEs5Library, lowerToEs5 } from './es5.ts'

describe('lowerToEs5', () => {
  // What the TypeScript sources write, which rolldown passes through as is.
  it.each([
    ['arrow functions', 'var f = (x) => x + 1'],
    ['const and let', 'const a = 1; let b = a; b += 1'],
    ['template literals', 'var name = "ada"; var s = `Patient/${name}`'],
    ['object spread', 'var a = { x: 1 }; var b = { ...a, y: 2 }'],
    ['array spread', 'var a = [1]; var b = [...a, 2]'],
    ['destructuring', 'var { payload } = { payload: 1 }; var [first] = [payload]'],
    ['for-of over an array', 'for (const n of [1, 2]) { n }'],
    ['optional chaining and nullish coalescing', 'var o = null; var v = o?.x ?? 3'],
    ['numeric separators', 'var ms = 60_000'],
  ])('should lower %s to code that parses as ES5', (_, source) => {
    // Act
    const lowered = lowerToEs5(source)

    // Assert
    expect(() => parse(lowered, { ecmaVersion: 5 })).not.toThrow()
  })

  it('should refuse what it cannot lower to ES5', () => {
    // A regular expression's `s` flag has no ES5 form; TypeScript leaves it be.
    expect(() => lowerToEs5('var r = /a.b/s')).toThrow()
  })

  it.each(['Symbol', 'Map', 'Set', 'WeakMap', 'Promise', 'Reflect'])(
    'should refuse code that reads the global %s',
    (global) => {
      expect(() => lowerToEs5(`var g = ${global}`)).toThrow(global)
    }
  )

  it('should accept those names as properties and in strings and comments', () => {
    const source = 'var o = {}; o.Symbol = "Map"; // Promise\nvar t = o.Set'
    expect(() => lowerToEs5(source)).not.toThrow()
  })
})

describe('checkEs5Library', () => {
  let projectDir: string

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'fhir-sync-pebble-es5-'))
    writeFileSync(
      join(projectDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { lib: ['es5'], types: [], strict: true, noEmit: true } })
    )
    writeFileSync(join(projectDir, 'es5.ts'), 'export const found = [1].indexOf(1)\n')
    writeFileSync(join(projectDir, 'es2016.ts'), 'export const found = [1].includes(1)\n')
  })

  afterAll(() => {
    rmSync(projectDir, { recursive: true })
  })

  it('should accept bundled sources that use only ES5 methods', () => {
    expect(() =>
      checkEs5Library(join(projectDir, 'tsconfig.json'), [join(projectDir, 'es5.ts')])
    ).not.toThrow()
  })

  it('should refuse a bundled source that uses a later method', () => {
    expect(() =>
      checkEs5Library(join(projectDir, 'tsconfig.json'), [
        join(projectDir, 'es5.ts'),
        join(projectDir, 'es2016.ts'),
      ])
    ).toThrow('includes')
  })
})
