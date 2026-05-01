// Import needed for module extension
import type { Schema } from 'effect'
import 'vite-plus/test'

interface CustomMatchers<R = unknown> {
  toSchemaEqual: <A, I>(schema: Schema.Schema<A, I>, expected: A) => R
}

declare module 'vite-plus/test' {
  // oxlint-disable-next-line typescript/no-explicit-any -- module-augmentation default for `Assertion<T>`; `unknown` would force every `expect()` call site into a manual cast.
  interface Assertion<T = any> extends CustomMatchers<T> {}
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}
