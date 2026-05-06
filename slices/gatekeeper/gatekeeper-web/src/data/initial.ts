const readInitial = <T>(): T | null => {
  if (typeof window === 'undefined') return null
  const value = window.__GATEKEEPER_INITIAL__
  if (value === undefined) return null
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as T
}

const clearInitial = (): void => {
  if (typeof window === 'undefined') return
  Reflect.deleteProperty(window, '__GATEKEEPER_INITIAL__')
}

export { readInitial, clearInitial }
