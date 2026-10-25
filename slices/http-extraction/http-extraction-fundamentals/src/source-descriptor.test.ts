import { Effect } from 'effect'
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

  it('should keep the completion a source gives, by reference', () => {
    const completeFromExtraction: SourceDescriptor.ExtractionCompletion<unknown> = () =>
      Effect.succeed((resource) => resource)

    const source = SourceDescriptor.make<unknown>({
      name: 'sample',
      display,
      responseKinds: [SimpleResponseKind],
      completeFromExtraction,
    })

    expect(source.completeFromExtraction).toBe(completeFromExtraction)
  })

  it('should leave the merge and the completion absent for a source that gives neither', () => {
    const source = SourceDescriptor.make<unknown>({
      name: 'sample',
      display,
      responseKinds: [SimpleResponseKind],
    })

    expect(source).not.toHaveProperty('mergeResources')
    expect(source).not.toHaveProperty('completeFromExtraction')
  })
})
