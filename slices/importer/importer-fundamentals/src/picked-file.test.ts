import { Effect, Encoding, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import * as PickedFile from './picked-file.ts'

const SYSTEM = 'https://example.test/fhir/CodeSystem/source-file'

const exampleFormat: PickedFile.FormatValue = {
  coding: { system: SYSTEM, code: 'example-source-file' },
  contentType: 'application/json',
  securityLabel: [{ system: 'https://example.test/fhir/CodeSystem/redaction', code: 'raw' }],
  descriptionPrefix: 'Example source file: ',
}

/** The same schema under a second format — what "another format's document" means below. */
const otherFormat: PickedFile.FormatValue = {
  ...exampleFormat,
  coding: { system: 'https://other.test/fhir/CodeSystem/source-file', code: 'other-source-file' },
}

const runAs = <A, E>(
  format: PickedFile.FormatValue,
  effect: Effect.Effect<A, E, PickedFile.Format>
): Promise<A> => Effect.runPromise(Effect.provideService(effect, PickedFile.Format, format))

const run = <A, E>(effect: Effect.Effect<A, E, PickedFile.Format>): Promise<A> =>
  runAs(exampleFormat, effect)

const encode = Schema.encode(PickedFile.FromDocumentReference)
const readBack = Schema.decode(PickedFile.FromDocumentReference)

const nameArbitrary = fc.stringMatching(/^[a-z0-9]{1,8}\.bin$/u)

/**
 * A pick as a batch hands it over. Its `id` is the batch slot, which the mint
 * ignores — every claim below about the archive's id is a claim about the
 * bytes and the name.
 */
const pickedArbitrary: fc.Arbitrary<PickedFile.Type> = fc
  .record({
    slot: fc.integer({ min: 0, max: 20 }),
    fileName: nameArbitrary,
    bytes: fc.uint8Array({ maxLength: 512 }),
  })
  .map(({ slot, fileName, bytes }) => ({ id: `${slot}:${fileName}`, fileName, bytes }))

const example = (overrides: Partial<PickedFile.Type> = {}): PickedFile.Type => ({
  id: '0:upload.bin',
  fileName: 'upload.bin',
  bytes: new TextEncoder().encode('example bytes'),
  ...overrides,
})

const digestOf = async (bytes: Uint8Array): Promise<string> => {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer)
  return Encoding.encodeBase64(new Uint8Array(digest))
}

describe('the mint — what encoding a pick decides', () => {
  it('property: the archive id is decided by the bytes and the name together, and by nothing else', async () => {
    await fc.assert(
      fc.asyncProperty(pickedArbitrary, pickedArbitrary, async (here, there) => {
        const [mintedHere, mintedThere] = await Promise.all([run(encode(here)), run(encode(there))])
        const sameFile =
          here.fileName === there.fileName &&
          Encoding.encodeBase64(here.bytes) === Encoding.encodeBase64(there.bytes)
        expect(mintedHere.id === mintedThere.id).toBe(sameFile)
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('namespaces the id by the coding system, so two formats never collide', async () => {
    const picked = example({ fileName: 'report.bin', bytes: new TextEncoder().encode('shared') })
    const here = await runAs(exampleFormat, encode(picked))
    const there = await runAs(otherFormat, encode(picked))
    expect(here.id).not.toBe(there.id)
  })

  it("ignores the value's own batch id, which the mint does not decide", async () => {
    const bytes = new TextEncoder().encode('same bytes')
    const first = await run(encode({ id: '0:same.bin', fileName: 'same.bin', bytes }))
    const second = await run(encode({ id: '7:same.bin', fileName: 'same.bin', bytes }))
    expect(first.id).toBe(second.id)
  })

  it('states no instant of any kind — not a date, not an attachment creation', async () => {
    const resource = await run(encode(example()))
    expect(resource.date).toBeNull()
    expect(resource.content[0]?.attachment.creation).toBeNull()
  })
})

describe('the codec as a schema', () => {
  test('property: an archive round-trips — the stored id, filename and bytes recovered exactly', async () => {
    await fc.assert(
      fc.asyncProperty(pickedArbitrary, async (picked) => {
        const resource = await run(encode(picked))
        const back = await run(readBack(resource))
        expect(back).toEqual({ id: resource.id, fileName: picked.fileName, bytes: picked.bytes })
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: decode then encode is the identity on the id', async () => {
    await fc.assert(
      fc.asyncProperty(pickedArbitrary, async (picked) => {
        const stored = await run(encode(picked))
        const back = await run(readBack(stored))
        const again = await run(encode(back))
        expect(back.id).toBe(stored.id)
        expect(again.id).toBe(stored.id)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: hash and size describe the attachment bytes, stored verbatim', async () => {
    await fc.assert(
      fc.asyncProperty(pickedArbitrary, async (picked) => {
        const attachment = (await run(encode(picked))).content[0]?.attachment
        expect(attachment?.size).toBe(picked.bytes.length)
        expect(attachment?.hash).toBe(await digestOf(picked.bytes))
        expect(attachment?.data).toBe(Encoding.encodeBase64(picked.bytes))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('bytes that are not valid UTF-8 survive the round trip', async () => {
    const picked = example({ bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41]) })
    const back = await run(encode(picked).pipe(Effect.flatMap(readBack)))
    expect(back.bytes).toEqual(picked.bytes)
  })

  test('property: the mint names no subject and no related resource, keeping archives out of Patient/$everything', async () => {
    await fc.assert(
      fc.asyncProperty(pickedArbitrary, async (picked) => {
        const resource = await run(encode(picked))
        expect(resource.subject).toBeNull()
        expect(resource.context).toBeNull()
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('carries the format context coding on both type and category', async () => {
    const resource = await run(encode(example()))
    expect(
      resource.type?.coding.map((one) => ({ system: one.system?.toString(), code: one.code }))
    ).toEqual([exampleFormat.coding])
    expect(
      resource.category.map((category) =>
        category.coding.map((one) => ({ system: one.system?.toString(), code: one.code }))
      )
    ).toEqual([[exampleFormat.coding]])
  })

  it('rejects a resource whose attachment carries no data', async () => {
    const resource = await run(encode(example()))
    const dataless = resource.content.map((entry) => ({
      ...entry,
      attachment: { ...entry.attachment, data: null },
    }))
    const outcome = await run(Effect.either(readBack({ ...resource, content: dataless })))
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.message).toContain('no data')
  })

  it('a decode failure names the offending resource, so a failing list says which one', async () => {
    const resource = await run(encode(example()))
    const outcome = await run(Effect.either(readBack({ ...resource, category: [] })))
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.message).toContain(resource.id ?? '')
  })

  it("another format's document is not this one's archive", async () => {
    const resource = await runAs(otherFormat, encode(example()))
    const outcome = await run(Effect.either(readBack(resource)))
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.message).toContain(exampleFormat.coding.code)
    expect(PickedFile.isSourceFile(exampleFormat)(resource)).toBe(false)
    expect(PickedFile.isSourceFile(otherFormat)(resource)).toBe(true)
  })
})

describe('the constants a reader of the server list projects', () => {
  it('states the category token in system|code form', () => {
    expect(PickedFile.categoryToken(exampleFormat)).toBe(`${SYSTEM}|example-source-file`)
  })

  it('recognizes an archive of its own format', async () => {
    const resource = await run(encode(example()))
    expect(PickedFile.isSourceFile(exampleFormat)(resource)).toBe(true)
  })
})
