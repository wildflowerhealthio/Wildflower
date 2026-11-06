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

  it('should keep the link across responses a source gives, by reference', () => {
    const linkAcrossResponses: SourceDescriptor.CrossResponseLink<unknown> = (responses) =>
      responses

    const source = SourceDescriptor.make<unknown>({
      name: 'sample',
      display,
      responseKinds: [SimpleResponseKind],
      linkAcrossResponses,
    })

    expect(source.linkAcrossResponses).toBe(linkAcrossResponses)
  })

  it('should leave the merge and the link absent for a source that gives neither', () => {
    const source = SourceDescriptor.make<unknown>({
      name: 'sample',
      display,
      responseKinds: [SimpleResponseKind],
    })

    expect(source).toStrictEqual({
      name: 'sample',
      display,
      responseKinds: [SimpleResponseKind],
    })
  })
})
