import { Schema } from 'effect'

import { drugNameSlug, plainDrugName } from './drug-name.ts'
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

/**
 * Normalize one raw RxHelp entry. The RxHelp list carries no per-drug province
 * restriction, so coverage is always expanded to {@link allProvinces}.
 */
const rxhelpToDrug = (raw: RxHelpRaw): SponsoredDrug => {
  const brandName = plainDrugName(raw.name)
  return {
    sponsor: 'rxhelp',
    id: drugNameSlug(brandName),
    brandName,
    genericName: plainDrugName(raw.genericName ?? ''),
    provinces: allProvinces,
  }
}

/** Decode and normalize a whole RxHelp file. Throws on a malformed file. */
const decodeRxHelpFile = (input: unknown): readonly SponsoredDrug[] =>
  Schema.decodeUnknownSync(RxHelpFile)(input).items.map(rxhelpToDrug)

export { RxHelpRaw, RxHelpFile, rxhelpToDrug, decodeRxHelpFile }
