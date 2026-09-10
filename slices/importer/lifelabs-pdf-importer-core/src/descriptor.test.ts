import { Effect, Option } from 'effect'
import { Extraction, HttpResponse, SourceDescriptor } from 'http-extraction-fundamentals'
import { describe, expect, it } from 'vite-plus/test'

import { lifeLabsPdfImporterDescriptor } from './descriptor.ts'
import { LifeLabsReportResponseKind } from './response-kind.ts'
import { defaultLifeLabsPdfSettings } from './settings.ts'
import { layoutDocument } from './test-helpers.ts'

describe('lifeLabsPdfImporterDescriptor', () => {
  it('binds the format tag, the default zone, and one source of one kind', () => {
    expect(lifeLabsPdfImporterDescriptor.format).toBe('lifelabs-pdf')
    expect(lifeLabsPdfImporterDescriptor.defaultSettings).toEqual(defaultLifeLabsPdfSettings)
    const pool = SourceDescriptor.poolOf(lifeLabsPdfImporterDescriptor.sources)
    expect(pool.map((kind) => kind.name)).toEqual([LifeLabsReportResponseKind.name])
  })

  it('routes every decoded response to its own kind and parses it — decode to resources with nothing written', () => {
    const text = JSON.stringify(layoutDocument([]))
    const pool = SourceDescriptor.poolOf(lifeLabsPdfImporterDescriptor.sources)

    const [input] = Effect.runSync(
      lifeLabsPdfImporterDescriptor.decode(text, defaultLifeLabsPdfSettings)
    )
    if (input === undefined) throw new Error('unreachable: decode yields one response')
    const routed = Extraction.routeTo(pool, input.url, input.method)

    expect(Option.isSome(routed)).toBe(true)
    if (Option.isNone(routed)) return
    const resources = Effect.runSync(routed.value.kind.parse(HttpResponse.make(input)))
    expect(resources).toEqual([])
  })
})
