import { describe, expect, it } from 'vite-plus/test'

import * as SourceDescriptor from './source-descriptor.ts'
import { SimpleResponseKind } from './test-helpers.ts'

const display = { title: 'Sample', description: 'A sample source.' }

describe('SourceDescriptor.make', () => {
  it('should keep the merge a source gives, by reference', () => {
    const mergeResources: SourceDescriptor.ResourceMerge<unknown> = (_earlier, later) => later

    const source = SourceDescriptor.make<unknown>({
      name: 'sample',
      display,
      responseKinds: [SimpleResponseKind],
      mergeResources,
    })

    expect(source.mergeResources).toBe(mergeResources)
  })

  it('should leave the merge absent for a source that gives none', () => {
    const source = SourceDescriptor.make<unknown>({
      name: 'sample',
      display,
      responseKinds: [SimpleResponseKind],
    })

    expect(source).not.toHaveProperty('mergeResources')
  })
})
