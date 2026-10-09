import { Load } from 'lifting-core-js'

/** Up to two decimals — enough for 1.25 lb micro-plates — and no trailing zeros. */
const amountFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

/** How a person reads each UCUM code a load is in. */
const DISPLAY_UNIT_OF: { readonly [Unit in Load.Unit]: string } = { '[lb_av]': 'lb', kg: 'kg' }

/** A unit as a person reads it, e.g. `"lb"` for `[lb_av]`. */
const formatUnit = (unit: Load.Unit): string => DISPLAY_UNIT_OF[unit]

/** A load as a person reads it, e.g. `"47.5 lb"`. */
const formatLoad = (load: Load.Type): string =>
  `${amountFormat.format(Load.valueOf(load))} ${formatUnit(Load.unitOf(load))}`

/** Reps per set as a compact run, e.g. `"5/5/5/4/3"`. */
const formatSetReps = (setReps: readonly number[]): string => setReps.join('/')

export { formatLoad, formatSetReps, formatUnit }
