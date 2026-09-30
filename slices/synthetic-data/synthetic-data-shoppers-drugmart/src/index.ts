/**
 * The Shoppers Drug Mart synthetic data generator: a family account's
 * `synthetic-data-fundamentals/story` `Story`s, filled under a
 * `ShoppersAccount`, as the HAR a mypharmacy.shoppersdrugmart.ca session
 * exports (`ShoppersHar.render`) — the customers, prescription-status and
 * prescription-history XHRs, in the JSON `shoppers-drugmart-source` reads.
 *
 * Deterministic: the same as-of day gives byte-identical output.
 *
 * @packageDocumentation
 */
export type {
  ShoppersAccount,
  ShoppersAddress,
  ShoppersPatient,
  ShoppersStore,
} from './shoppers-account.ts'
export * as ShoppersHar from './shoppers-har.ts'
