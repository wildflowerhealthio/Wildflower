import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { type HarSettings, harImporterDescriptor } from 'har-importer-core'
import {
  HarSettingsPicker,
  ReviewBody,
  type ReviewBodyProps,
  type SettingsPickerProps,
} from 'har-importer-react'
import type { FileImporterDescriptor } from 'importer-fundamentals'
import type { JSX } from 'react'

/**
 * The closed, compile-time `format → { descriptor, SettingsPicker, ReviewBody }`
 * registry: the single edit point for wiring a file-format importer into the
 * shell. Mirrors the collector slice's `configForms` idiom — both halves (the
 * data descriptor and the two React views) live here, since the importer has no
 * HTTP wire union to derive and so needs no separate registry package.
 *
 * @remarks
 * Registering a format is one static edit: add a key whose value is a full
 * {@link FormatRegistration}. The interface requires all three parts, so a
 * format missing its descriptor, its settings picker, or its review body fails
 * to compile here rather than at runtime. Only `har` is registered so far.
 *
 * @packageDocumentation
 */

/**
 * The three parts a file format contributes: the data descriptor and the two
 * React views the shell mounts around it.
 *
 * @typeParam TSettings - The format's settings shape
 * @typeParam TParsed - The resource type the format decodes to
 * @typeParam R - The services the descriptor's `persist` requires
 */
interface FormatRegistration<TSettings, TParsed, R> {
  readonly descriptor: FileImporterDescriptor<TSettings, TParsed, R>
  readonly SettingsPicker: (props: SettingsPickerProps<TSettings>) => JSX.Element
  readonly ReviewBody: (props: ReviewBodyProps) => JSX.Element
}

/** The HAR format's registration: its descriptor plus its (no-op) settings and review views. */
const harRegistration: FormatRegistration<HarSettings, FhirResource, FhirR4ResourcesHttpApiClient> =
  {
    descriptor: harImporterDescriptor,
    SettingsPicker: HarSettingsPicker,
    ReviewBody,
  }

/** The closed registry; its keys are the {@link Format} union. */
const formatRegistry = { har: harRegistration } as const

/** Every registered file-format tag. */
type Format = keyof typeof formatRegistry

export { formatRegistry, harRegistration }
export type { Format, FormatRegistration }
