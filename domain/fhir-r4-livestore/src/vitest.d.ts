// Import needed for module extension
import 'vite-plus/test'

interface CustomMatchers<R = unknown> {
  toSchemaEqual: (expected: unknown) => R
}

declare module 'vite-plus/test' {
  interface Assertion<T = any> extends CustomMatchers<T> {}
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}
