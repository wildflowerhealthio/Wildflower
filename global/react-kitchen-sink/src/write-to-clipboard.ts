/**
 * Async-clipboard write with a graceful fallback. The Clipboard API
 * isn't guaranteed (older WebView contexts, non-secure origins, denied
 * permission); a failed copy stays silent rather than throwing into a
 * click handler. A future slice can wire toast feedback.
 */
const writeToClipboard = async (text: string): Promise<void> => {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Best-effort — clipboard writes can reject (permissions, focus); the
    // copied text is already on screen beside the button.
  }
}

export { writeToClipboard }
