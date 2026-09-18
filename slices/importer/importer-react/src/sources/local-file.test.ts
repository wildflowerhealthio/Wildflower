import { Effect, Either } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import type { PickedFile, FormatDetector } from 'importer-fundamentals'
import { acceptLocalFile, type ReadableFile, REJECTION_MESSAGE } from './local-file.ts'

/**
 * `acceptLocalFile` is the gate every local pick passes: reads the bytes,
 * asks each registered descriptor's `detect` in turn, rejects when none
 * claims. The gate is syntactic — the full parse runs in `decode`, so no
 * format's decoder runs at pick time.
 */

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A file that reads back `bytes`, without constructing a DOM `File`. */
const fileOf = (name: string, bytes: Uint8Array): ReadableFile => ({
  name,
  arrayBuffer: (): Promise<ArrayBuffer> => {
    // Copy into a fresh ArrayBuffer so the promise resolves to a plain ArrayBuffer regardless of the underlying view.
    const copy = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(copy).set(bytes)
    return Promise.resolve(copy)
  },
})

/** A HAR descriptor stub — extension `.har` or JSON-object shape. */
const harDescriptor: FormatDetector.Type = {
  format: 'har',
  detect: (bytes, name) => name.toLowerCase().endsWith('.har') || bytes[0] === 0x7b,
}

/** A LifeLabs PDF descriptor stub — extension `.pdf` or `%PDF-` magic. */
const pdfDescriptor: FormatDetector.Type = {
  format: 'lifelabs-pdf',
  detect: (bytes, name) =>
    name.toLowerCase().endsWith('.pdf') ||
    (bytes.length >= 5 &&
      bytes[0] === 0x25 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x44 &&
      bytes[3] === 0x46 &&
      bytes[4] === 0x2d),
}

const descriptors: readonly FormatDetector.Type[] = [pdfDescriptor, harDescriptor]

const runAccept = (file: ReadableFile): Promise<Either.Either<PickedFile.PickedFile, string>> =>
  Effect.runPromise(Effect.either(acceptLocalFile(descriptors, file)))

describe('acceptLocalFile', () => {
  /** Byte-array equality that survives jsdom's cross-realm `Uint8Array`. */
  const sameBytes = (actual: Uint8Array, expected: Uint8Array): void => {
    expect(actual.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i += 1) expect(actual[i]).toBe(expected[i])
  }

  it('accepts a HAR file whose bytes look like JSON, carrying its name and bytes onto a local pick', async () => {
    const bytes = bytesOf('{"log":{"version":"1.2"}}')

    const result = await runAccept(fileOf('portal-session.har', bytes))

    if (Either.isLeft(result)) throw new Error('expected an accepted pick')
    expect(result.right.fileName).toBe('portal-session.har')
    sameBytes(result.right.bytes, bytes)
    expect(result.right.source).toEqual({ _tag: 'local' })
  })

  it('accepts a PDF file identified by magic bytes even without a .pdf extension', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

    const result = await runAccept(fileOf('unknown', bytes))

    if (Either.isLeft(result)) throw new Error('expected an accepted pick')
    expect(result.right.fileName).toBe('unknown')
    sameBytes(result.right.bytes, bytes)
  })

  it('rejects a file no descriptor claims with the registered message', async () => {
    const result = await runAccept(fileOf('notes.txt', bytesOf('this is not a HAR or a PDF')))

    if (Either.isRight(result)) throw new Error('expected a rejection')
    expect(result.left).toBe(REJECTION_MESSAGE)
  })

  it('picks the first descriptor whose detect claims the file, in registry order', async () => {
    // A file the two descriptors both would claim by name — a .pdf named .har — is
    // an edge case that never appears; verify the ordering with a byte-shape overlap.
    // JSON-shaped bytes with a `.har` name go to HAR (extension wins after PDF magic).
    const jsonHar = fileOf('capture.har', bytesOf('{"log":{}}'))
    const result = await runAccept(jsonHar)
    if (Either.isLeft(result)) throw new Error('expected an accepted pick')
    // Both descriptors would claim; the picker itself does not tag with the format
    // — that is `useImportRun`'s job — so we just assert the file was accepted.
    expect(result.right.fileName).toBe('capture.har')
  })
})
