/**
 * Merges class name arguments into a single space-separated string.
 * Accepts strings, falsy values (ignored), and `Record<string, boolean>`
 * objects where keys are class names and values control inclusion.
 */
export const cn = (
  ...args: (string | undefined | null | false | Record<string, boolean>)[]
): string => {
  const result: string[] = []
  for (const a of args) {
    if (!a) {
      continue
    }
    if (typeof a === 'string') {
      result.push(a)
    } else if (typeof a === 'object') {
      for (const [className, enabled] of Object.entries(a)) {
        if (enabled) {
          result.push(className)
        }
      }
    }
  }
  return result.join(' ')
}
