import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { decodeDicom } from './decode.ts'
import { defaultDicomSettings } from './settings.ts'

describe('decodeDicom', () => {
  it('yields zero sections — D3 adds tag parsing', async () => {
    const result = await Effect.runPromise(
      decodeDicom(new Uint8Array([0x00, 0x01, 0x02]), defaultDicomSettings)
    )
    expect(result.sections).toEqual([])
  })

  it('yields one diagnostic note explaining the contents are not extracted', async () => {
    const result = await Effect.runPromise(decodeDicom(new Uint8Array(), defaultDicomSettings))
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('not extracted yet')
  })
})
