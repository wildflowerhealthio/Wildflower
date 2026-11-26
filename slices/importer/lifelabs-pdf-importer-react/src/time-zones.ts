/**
 * The time zones the LifeLabs PDF settings picker offers without typing.
 *
 * @remarks
 * A separate module from the picker component so the `.tsx` exports only
 * components and literal constants — what `react(only-export-components)`
 * wants for fast refresh.
 *
 * @packageDocumentation
 */

/** The zones LifeLabs reports are issued in, offered as suggestions. */
const SUGGESTED_TIME_ZONES = ['America/Toronto', 'America/Vancouver'] as const

export { SUGGESTED_TIME_ZONES }
