import { Schema } from 'effect'

import { allProvinces, parseProvinceList } from './province.ts'
import type { SponsoredDrug } from './sponsor.ts'

/**
 * Raw shape of one entry in the innoviCares sponsored-drug list. Only the
 * fields the app consumes are described; unknown keys are ignored by
 * `Schema.Struct`'s default (non-exhaustive) decoding.
 */
const InnovicaresRaw = Schema.Struct({
  title: Schema.String,
  subtitle: Schema.optional(Schema.String),
  provinces: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
})
type InnovicaresRaw = typeof InnovicaresRaw.Type

/** The innoviCares file is a bare array of drug entries. */
const InnovicaresFile = Schema.Array(InnovicaresRaw)

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

/** Where an innoviCares entry with no per-drug page links instead. */
const INNOVICARES_HOME = 'https://www.innovicares.ca/en/'

/**
 * Normalize one raw innoviCares entry. An absent or empty `provinces` string is
 * treated as "covered everywhere" (expanded to {@link allProvinces}); an entry
 * with no `url` falls back to the innoviCares home page so every drug links
 * somewhere.
 */
const innovicaresToDrug = (raw: InnovicaresRaw): SponsoredDrug => {
  const listed =
    raw.provinces !== undefined && raw.provinces.trim().length > 0
      ? parseProvinceList(raw.provinces)
      : allProvinces
  return {
    sponsor: 'innovicares',
    id: slug(raw.title),
    brandName: stripMarks(raw.title),
    genericName: raw.subtitle ?? '',
    provinces: listed,
    url: raw.url !== undefined && raw.url.trim().length > 0 ? raw.url : INNOVICARES_HOME,
  }
}

/** Decode and normalize a whole innoviCares file. Throws on a malformed file. */
const decodeInnovicaresFile = (input: unknown): readonly SponsoredDrug[] =>
  Schema.decodeUnknownSync(InnovicaresFile)(input).map(innovicaresToDrug)

export { InnovicaresRaw, InnovicaresFile, innovicaresToDrug, decodeInnovicaresFile }
