import type { ConsentStorage } from '@wildflowerhealthio/telemetry-core'

/** A `ConsentStorage` kept in a `Map`, standing in for `window.localStorage`. */
const mapConsentStorage = (): ConsentStorage => {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    },
  }
}

/**
 * jsdom has no native `<dialog>`; model `showModal`/`close` as the `open`
 * attribute (as react-tundraish's own Dialog tests do), and restore the
 * original descriptors afterwards so the patch can't leak into other files.
 */
const dialogMethods = ['showModal', 'close'] as const
const originalDialogDescriptors = dialogMethods.map(
  (key) => [key, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, key)] as const
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
  for (const [key, descriptor] of originalDialogDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, key)
    else Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
  }
}

/** The `<dialog>` on the page while it is open, or `null`. */
const openDialog = (): HTMLDialogElement | null => document.querySelector('dialog[open]')

export { mapConsentStorage, openDialog, restoreDialogModality, stubDialogModality }
