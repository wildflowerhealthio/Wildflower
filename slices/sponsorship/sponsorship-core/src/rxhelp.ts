import { Schema } from 'effect'

import { allProvinces, isProvince } from './province.ts'
import type { SponsoredDrug } from './sponsor.ts'

/** RxHelp embeds logos inline as base64 `data:` URIs under `logo.content`. */
const RxHelpLogo = Schema.Struct({
  content: Schema.optional(Schema.String),
})

/**
 * Raw shape of one entry in the RxHelp `items` array. Only consumed fields are
 * described; the many others (French names, cards, promotional text) are
 * ignored.
 */
const RxHelpRaw = Schema.Struct({
  encId: Schema.optional(Schema.String),
  name: Schema.String,
  nameHtml: Schema.optional(Schema.String),
  genericName: Schema.optional(Schema.String),
  provinces: Schema.optional(Schema.Array(Schema.String)),
  logo: Schema.optional(RxHelpLogo),
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
 * Normalize one raw RxHelp entry. An absent or empty `provinces` array is
 * treated as "covered everywhere" (expanded to {@link allProvinces}); unknown
 * province tokens are dropped.
 */
const rxhelpToDrug = (raw: RxHelpRaw): SponsoredDrug => {
  const codes = (raw.provinces ?? []).map((code) => code.trim().toUpperCase()).filter(isProvince)
  return {
    sponsor: 'rxhelp',
    id: raw.encId ?? slug(raw.name),
    brandName: stripMarks(raw.name),
    brandHtml: raw.nameHtml,
    genericName: raw.genericName ?? '',
    provinces: codes.length > 0 ? codes : allProvinces,
    logoDataUri: raw.logo?.content,
  }
}

/** Decode and normalize a whole RxHelp file. Throws on a malformed file. */
const decodeRxHelpFile = (input: unknown): readonly SponsoredDrug[] =>
  Schema.decodeUnknownSync(RxHelpFile)(input).items.map(rxhelpToDrug)

export { RxHelpRaw, RxHelpFile, rxhelpToDrug, decodeRxHelpFile }
