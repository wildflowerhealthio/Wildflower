import { Effect, Either, Schema } from 'effect'
import { type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import type { DataSetManifest } from 'synthetic-data-core'
import { describe, expect, it } from 'vite-plus/test'

import { DataSetReadFailed, readManifest, readResources } from './data-set-read.ts'
import {
  DATA_SET_URL,
  dataSetFixture,
  HAR_BYTES,
  PEOPLE,
  staticHostOf,
  type StaticHost,
} from './data-set.test-helpers.ts'

const root = new URL(DATA_SET_URL)

const encodeResource = Schema.encodeSync(FhirResourceSchema)

const manifestOf = (host: StaticHost): Promise<DataSetManifest.Type> =>
  Effect.runPromise(readManifest(root, host.fetch))

const resourcesOf = (
  host: StaticHost,
  paths: readonly string[]
): Promise<Either.Either<readonly FhirResource[], DataSetReadFailed>> =>
  Effect.runPromise(Effect.either(readResources(root, paths, host.fetch, () => undefined)))

/** Every resource path in the fixture's manifest. */
const allResourcePaths = async (host: StaticHost): Promise<readonly string[]> =>
  (await manifestOf(host)).people.flatMap((person) => person.resources)

describe('readManifest', () => {
  it('should read the people and their files from index.json', async () => {
    const { files } = await dataSetFixture()
    const manifest = await manifestOf(staticHostOf(files))

    expect(manifest.people.map(({ key, displayName }) => ({ key, displayName }))).toEqual(
      PEOPLE.map(({ key, displayName }) => ({ key, displayName }))
    )
    expect(manifest.people.map((person) => person.patientIds)).toEqual([
      ['patient-a'],
      ['patient-b'],
    ])
  })

  it('should fail naming index.json when the host has none', async () => {
    const { files } = await dataSetFixture()
    const host = staticHostOf(files, new Map([['index.json', undefined]]))

    const result = await Effect.runPromise(Effect.either(readManifest(root, host.fetch)))

    expect(result).toEqual(
      Either.left(
        new DataSetReadFailed({
          path: 'index.json',
          message: 'index.json: the host answered 404 Not Found.',
        })
      )
    )
  })

  it('should fail when index.json is not a manifest', async () => {
    const { files } = await dataSetFixture()
    const host = staticHostOf(files, new Map([['index.json', '{"schemaVersion":2}']]))

    const result = await Effect.runPromise(Effect.either(readManifest(root, host.fetch)))

    if (Either.isRight(result)) throw new Error('expected the read to fail')
    expect(result.left.path).toBe('index.json')
    expect(result.left.message).toMatch(/^index\.json: it is not a data set manifest\. /)
  })
})

describe('readResources', () => {
  it('should read every resource as imported, the source file carrying its HAR inline again', async () => {
    const { files, resourcesByLabel } = await dataSetFixture()
    const host = staticHostOf(files)
    const paths = [...new Set(await allResourcePaths(host))]

    const resources = Either.getOrThrow(await resourcesOf(host, paths))

    expect(resources.map((resource) => encodeResource(resource))).toEqual(
      paths.map((path) => {
        const imported = resourcesByLabel.get(path.replace(/^fhir\/(.+)\.json$/, '$1'))
        if (imported === undefined) throw new Error(`${path} is not in the fixture`)
        return encodeResource(imported)
      })
    )
    // The HAR was fetched from the data set to be inlined.
    expect(host.requestedUrls).toContain(`${DATA_SET_URL}har/family.har`)
  })

  it('should call back once per file read', async () => {
    const { files } = await dataSetFixture()
    const host = staticHostOf(files)
    const paths = [...new Set(await allResourcePaths(host))]
    let filesRead = 0

    await Effect.runPromise(
      readResources(root, paths, host.fetch, () => {
        filesRead += 1
      })
    )

    expect(filesRead).toBe(paths.length)
  })

  it('should fail naming a resource file the host does not have', async () => {
    const { files } = await dataSetFixture()
    const host = staticHostOf(files, new Map([['fhir/Observation/obs-a2.json', undefined]]))

    const result = await resourcesOf(host, await allResourcePaths(host))

    expect(result).toEqual(
      Either.left(
        new DataSetReadFailed({
          path: 'fhir/Observation/obs-a2.json',
          message: 'fhir/Observation/obs-a2.json: the host answered 404 Not Found.',
        })
      )
    )
  })

  it('should fail when a static file is not the size its source file states', async () => {
    const { files } = await dataSetFixture()
    const host = staticHostOf(files, new Map([['har/family.har', 'too short']]))

    const result = await resourcesOf(host, await allResourcePaths(host))

    expect(result).toEqual(
      Either.left(
        new DataSetReadFailed({
          path: 'har/family.har',
          message: `har/family.har: it is 9 bytes, and its source file says ${HAR_BYTES.length}.`,
        })
      )
    )
  })

  it('should fail when a static file is not the one its source file hashes', async () => {
    const { files } = await dataSetFixture()
    const tampered = new Uint8Array(HAR_BYTES)
    tampered[tampered.length - 2] = 0x20
    const host = staticHostOf(files, new Map([['har/family.har', tampered]]))

    const result = await resourcesOf(host, await allResourcePaths(host))

    expect(result).toEqual(
      Either.left(
        new DataSetReadFailed({
          path: 'har/family.har',
          message: 'har/family.har: its SHA-256 is not the one its source file states.',
        })
      )
    )
  })

  it('should fail when a file holds a resource other than the one its path names', async () => {
    const { files } = await dataSetFixture()
    const blairPatient = files.find(({ path }) => path === 'fhir/Patient/patient-b.json')
    if (blairPatient === undefined) throw new Error('expected Blair’s Patient file')
    const host = staticHostOf(
      files,
      new Map([['fhir/Patient/patient-a.json', blairPatient.contents]])
    )

    const result = await resourcesOf(host, ['fhir/Patient/patient-a.json'])

    expect(result).toEqual(
      Either.left(
        new DataSetReadFailed({
          path: 'fhir/Patient/patient-a.json',
          message:
            'fhir/Patient/patient-a.json: it holds Patient/patient-b, not the resource its path names.',
        })
      )
    )
  })
})
