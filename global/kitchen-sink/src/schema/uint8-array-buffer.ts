import { Either, Schema, Encoding, pipe, ParseResult, type FastCheck } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'

const arbitraryArrayBuffer = (): LazyArbitrary<Uint8Array<ArrayBuffer>> => (fc: typeof FastCheck) =>
  fc.uint8Array().map((arr) => new Uint8Array(arr.slice()))

const Uint8ArrayBufferFromSelf: Schema.Schema<
  Uint8Array<ArrayBuffer>,
  Uint8Array<ArrayBuffer>
> = Schema.declare(
  (input: unknown): input is Uint8Array<ArrayBuffer> => {
    return (
      input instanceof Uint8Array &&
      Object.prototype.toString.call(input.buffer) === '[object ArrayBuffer]'
    )
  } // && input instanceof Uint8Array && input.buffer[Symbol.toStringTag] === 'ArrayBuffer'
).annotations({
  arbitrary: arbitraryArrayBuffer,
  description: 'a Uint8Array with an ArrayBuffer as its buffer',
})

const Base64FromUint8ArrayBuffer: Schema.Schema<
  string,
  Uint8Array<ArrayBuffer>
> = Schema.transformOrFail(
  Uint8ArrayBufferFromSelf,
  Schema.String.annotations({ description: 'a base64-encoded string representation of the bytes' }),
  {
    strict: true,
    encode: (i, _, ast) =>
      pipe(
        Encoding.decodeBase64(i),
        Either.flatMap((data) => Schema.decodeUnknownEither(Uint8ArrayBufferFromSelf)(data)),
        Either.mapLeft((decodeException) => new ParseResult.Type(ast, i, decodeException.message))
      ),
    decode: (a) => ParseResult.succeed(Encoding.encodeBase64(a)),
  }
).annotations({
  identifier: 'Base64FromUint8ArrayBuffer',
  arbitrary: () => (fc: typeof FastCheck) =>
    arbitraryArrayBuffer()(fc).map((a) => Encoding.encodeBase64(a)),
})

export { Base64FromUint8ArrayBuffer, Uint8ArrayBufferFromSelf }
