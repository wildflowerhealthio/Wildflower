import { gzipSync } from 'node:zlib'

import { describe, expect, test } from 'vite-plus/test'

import { pageScriptSizes, SHARED_REACT_CHUNK, type ScriptChunk } from './page-script-budget.ts'

const chunk = (fileName: string, overrides: Partial<ScriptChunk> = {}): ScriptChunk => ({
  fileName,
  isEntry: false,
  name: fileName.replace(/\.js$/, ''),
  code: `export const ${fileName.replace(/\W/g, '_')} = ${JSON.stringify(fileName.repeat(20))}`,
  imports: [],
  ...overrides,
})

const gzipped = (...chunks: readonly ScriptChunk[]): number =>
  chunks.reduce((total, counted) => total + gzipSync(counted.code).byteLength, 0)

describe('pageScriptSizes', () => {
  test("a page counts its entry and everything it imports statically, each once, but React's chunk", () => {
    const react = chunk('react.js', { name: SHARED_REACT_CHUNK })
    const runtime = chunk('runtime.js', { imports: [react.fileName] })
    const effect = chunk('effect.js', { imports: [runtime.fileName] })
    const later = chunk('later.js')
    const consent = chunk('consent.js', {
      isEntry: true,
      name: 'consent',
      imports: [effect.fileName, runtime.fileName, react.fileName],
    })
    const device = chunk('device.js', {
      isEntry: true,
      name: 'device',
      imports: [runtime.fileName, react.fileName],
    })

    expect(pageScriptSizes([react, runtime, effect, later, consent, device])).toEqual([
      { page: 'consent', gzippedBytes: gzipped(consent, effect, runtime) },
      { page: 'device', gzippedBytes: gzipped(device, runtime) },
    ])
  })
})
