import { describe, expect, it } from 'vite-plus/test'

import * as PickedFileSource from './picked-file.ts'

describe('PickedFileSource', () => {
  it('should build a server source carrying the reference form of the id', () => {
    expect(PickedFileSource.server('doc-9')).toEqual({
      _tag: 'server',
      reference: 'DocumentReference/doc-9',
    })
  })
})
