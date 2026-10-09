import { fireEvent, screen } from '@testing-library/react'
import { TELEMETRY_CONSENT_COPY } from 'branding-core'
import { type TelemetryConsent, writeConsent } from 'telemetry-core'

/** The two switches of the consent dialog. */
type ConsentSwitches = Pick<TelemetryConsent, 'crashReports' | 'performance'>

/** Stores a current answer in the page's `localStorage`, as a returning visitor has one. */
const storeConsent = (switches: ConsentSwitches): void => {
  writeConsent(window.localStorage, {
    version: TELEMETRY_CONSENT_COPY.version,
    decidedAt: '2026-09-29T12:00:00.000Z',
    ...switches,
  })
}

/** Sets the open consent dialog's switches to `switches` and presses Continue. */
const answerDialog = (switches: ConsentSwitches): void => {
  for (const [label, wanted] of [
    [TELEMETRY_CONSENT_COPY.crashReports.label, switches.crashReports],
    [TELEMETRY_CONSENT_COPY.performance.label, switches.performance],
  ] as const) {
    const toggle = screen.getByRole<HTMLInputElement>('switch', { name: label })
    if (toggle.checked !== wanted) fireEvent.click(toggle)
  }
  fireEvent.click(screen.getByRole('button', { name: TELEMETRY_CONSENT_COPY.continueLabel }))
}

/** The consent `<dialog>` while it is open, or `null`. */
const openDialog = (): HTMLDialogElement | null => document.querySelector('dialog[open]')

/**
 * jsdom has no native `<dialog>`: `showModal` and `close` are modelled as the
 * `open` attribute, and {@link restoreDialogModality} puts the original
 * descriptors back so the patch cannot leak into other files.
 */
const dialogMethodDescriptors = (['showModal', 'close'] as const).map(
  (method) =>
    [method, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method)] as const
)

/** Opens the dialog the way the native `showModal` shows it: the `open` attribute. */
function showModalByAttribute(this: HTMLDialogElement): void {
  this.setAttribute('open', '')
}

/** Closes the dialog as the native `close` does: drops `open`, then fires `close`. */
function closeByAttribute(this: HTMLDialogElement): void {
  this.removeAttribute('open')
  this.dispatchEvent(new Event('close'))
}

const stubDialogModality = (): void => {
  HTMLDialogElement.prototype.showModal = showModalByAttribute
  HTMLDialogElement.prototype.close = closeByAttribute
}

const restoreDialogModality = (): void => {
  for (const [method, descriptor] of dialogMethodDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, method)
    else Object.defineProperty(HTMLDialogElement.prototype, method, descriptor)
  }
}

export { answerDialog, openDialog, restoreDialogModality, storeConsent, stubDialogModality }
