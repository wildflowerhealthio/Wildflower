import { describe, expect, it } from 'vite-plus/test'

import * as PickedFile from './picked-file.ts'

describe('PickedFile.Source', () => {
  it('should build a server source carrying the reference form of the id', () => {
    expect(PickedFile.Source.server('doc-9')).toEqual({
      _tag: 'server',
      reference: 'DocumentReference/doc-9',
    })
  })
})
