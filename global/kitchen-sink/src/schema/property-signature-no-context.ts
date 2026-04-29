// oxlint-disable typescript/no-explicit-any
import type { PropertySignature } from 'effect/Schema'
/**
 *
 */
type Any<Key extends PropertyKey = PropertyKey> = PropertySignature<
  PropertySignature.Token,
  any,
  Key,
  PropertySignature.Token,
  any,
  boolean,
  never
>

/**
 * @since 3.10.0
 */
type All<Key extends PropertyKey = PropertyKey> =
  | Any<Key>
  | PropertySignature<
      PropertySignature.Token,
      never,
      Key,
      PropertySignature.Token,
      any,
      boolean,
      never
    >
  | PropertySignature<
      PropertySignature.Token,
      any,
      Key,
      PropertySignature.Token,
      never,
      boolean,
      never
    >
  | PropertySignature<
      PropertySignature.Token,
      never,
      Key,
      PropertySignature.Token,
      never,
      boolean,
      never
    >

export type { All }
