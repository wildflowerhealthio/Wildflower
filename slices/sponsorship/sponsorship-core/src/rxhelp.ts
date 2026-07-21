import { Schema } from 'effect'

import { allProvinces } from './province.ts'
import type { SponsoredDrug } from './sponsor.ts'

/**
 * Raw shape of one entry in the RxHelp `items` array. Only consumed fields are
 * described; the many others (French names, logos, cards, promotional text) are
 * ignored.
 */
const RxHelpRaw = Schema.Struct({
  name: Schema.String,
  genericName: Schema.optional(Schema.String),
})
type RxHelpRaw = typeof RxHelpRaw.Type

/** The RxHelp file is an object with an `items` array. */
const RxHelpFile = Schema.Struct({
  items: Schema.Array(RxHelpRaw),
})

const stripMarks = (value: string): string =>
  value
    .replace(/<[^>]*>/g, '')
    .replace(/[\u00ae\u2122\u00a9]/g, '')
    .trim()

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/**
 * Normalize one raw RxHelp entry. The RxHelp list carries no per-drug province
 * restriction, so coverage is always expanded to {@link allProvinces}.
 */
const rxhelpToDrug = (raw: RxHelpRaw): SponsoredDrug => ({
  sponsor: 'rxhelp',
  id: slug(raw.name),
  brandName: stripMarks(raw.name),
  genericName: raw.genericName ?? '',
  provinces: allProvinces,
})

/** Decode and normalize a whole RxHelp file. Throws on a malformed file. */
const decodeRxHelpFile = (input: unknown): readonly SponsoredDrug[] =>
  Schema.decodeUnknownSync(RxHelpFile)(input).items.map(rxhelpToDrug)

export { RxHelpRaw, RxHelpFile, rxhelpToDrug, decodeRxHelpFile }
