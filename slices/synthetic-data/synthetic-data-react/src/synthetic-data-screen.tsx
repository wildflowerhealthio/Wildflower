import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Effect, Either, Function as Fn } from 'effect'
import { type JSX, type SubmitEvent, useState } from 'react'
import { Checkbox, TextField } from 'react-tundraish'
import { LoadingLine, ReadFailureLine } from 'smart-app-react'
import type { DataSetManifest } from 'synthetic-data-core'

import { type Fetch, readManifest } from './data-set-read.ts'
import { dataSetRootOf } from './data-set-url.ts'
import { resourcePathsOf, resourceTypeCountsOf } from './load-plan.ts'
import { LoadResults } from './load-results.tsx'
import { plural } from './plural.ts'
import { type DataSetLoad, type DataSetLoader, useDataSetLoad } from './use-data-set-load.ts'
import styles from './synthetic-data-screen.module.css'

/**
 * The whole load flow on one screen: which data set, who in it, the load,
 * and what it wrote.
 */

/**
 * `globalThis.fetch`, looked up at call time so a test's stub is the one used.
 * No credentials: a data set is public files, and a `?dataSet=` naming this
 * app's own origin must not read them with its cookies.
 */
const fetchFromWindow: Fetch = (url) => globalThis.fetch(url, { credentials: 'omit' })

/** The manifest reads' query key prefix; each read adds its root. */
const MANIFEST_QUERY_KEY = 'synthetic-data-manifest'

/** Whether a load is reading or writing, when nothing may change under it. */
const isRunning = (
  load: DataSetLoad
): load is Extract<DataSetLoad, { readonly _tag: 'reading' | 'writing' }> =>
  load._tag === 'reading' || load._tag === 'writing'

/**
 * The data set URL, as a form the reader submits to read a data set again or
 * read another one; locked while a load runs.
 */
const DataSetForm = ({
  dataSetUrl,
  disabled,
  onDataSetUrlSubmit,
}: {
  readonly dataSetUrl: string
  readonly disabled: boolean
  readonly onDataSetUrlSubmit: (dataSetUrl: string) => void
}): JSX.Element => {
  const [draftUrl, setDraftUrl] = useState(dataSetUrl)
  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    onDataSetUrlSubmit(draftUrl.trim())
  }
  return (
    <form aria-label="Data set" onSubmit={submit}>
      <fieldset className={styles.dataSetFields} disabled={disabled}>
        <TextField
          label="Data set URL"
          type="url"
          inputMode="url"
          value={draftUrl}
          onChange={setDraftUrl}
          description="The folder that holds the data set's index.json: the published set, or one served on this computer."
        />
        <button type="submit" className="button-2 outline">
          Read data set
        </button>
      </fieldset>
    </form>
  )
}

/** A person's checkbox label: their name, what their records show, and what the files hold. */
const PersonLabel = ({
  person,
}: {
  readonly person: DataSetManifest.Type['people'][number]
}): JSX.Element => {
  const counts = resourceTypeCountsOf(person.resources)
    .map(({ resourceType, count }) => `${count} ${resourceType}`)
    .join(', ')
  return (
    <span className={styles.person}>
      <span className={styles.personName}>{person.displayName}</span>
      {person.summary !== '' && <span className={styles.personSummary}>{person.summary}</span>}
      <span className={styles.personCounts}>
        {person.resources.length} {plural(person.resources.length, 'resource')} ({counts}) ·{' '}
        {person.staticFiles.length} {plural(person.staticFiles.length, 'source file')}
      </span>
    </span>
  )
}

/** A running load's progress: a bar and a line saying how far it is. */
const LoadProgress = ({
  load,
}: {
  readonly load: Extract<DataSetLoad, { readonly _tag: 'reading' | 'writing' }>
}): JSX.Element => {
  const [done, total, line] =
    load._tag === 'reading'
      ? [load.filesRead, load.fileCount, `Reading ${load.filesRead} of ${load.fileCount} files…`]
      : [
          load.resourcesSubmitted,
          load.resourceCount,
          `Writing ${load.resourcesSubmitted} of ${load.resourceCount} resources…`,
        ]
  return (
    <div className={styles.progress}>
      <progress value={done} max={total} aria-label={line} />
      <p role="status" className={styles.progressLine}>
        {line}
      </p>
    </div>
  )
}

/**
 * The people in one data set, the load button, and the load: every person
 * is picked to begin with, and nothing can be re-picked while a load runs.
 */
const PeopleLoad = ({
  root,
  manifest,
  serverUrl,
  loader,
}: {
  readonly root: URL
  readonly manifest: DataSetManifest.Type
  readonly serverUrl: string
  readonly loader: DataSetLoader
}): JSX.Element => {
  // Tracked as who is left out, so everyone starts picked.
  const [unpickedKeys, setUnpickedKeys] = useState<ReadonlySet<string>>(new Set())
  // Who the last load was for, so its results keep naming them after a re-pick.
  const [loadedPeopleNames, setLoadedPeopleNames] = useState<readonly string[]>([])
  const { load, start, reset } = loader
  const running = isRunning(load)
  const pickedPeople = manifest.people.filter((person) => !unpickedKeys.has(person.key))

  const setPicked = (key: string, picked: boolean): void => {
    setUnpickedKeys((latestUnpicked) => {
      const next = new Set(latestUnpicked)
      if (picked) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const startLoad = (): void => {
    setLoadedPeopleNames(pickedPeople.map((person) => person.displayName))
    start(root, resourcePathsOf(manifest, new Set(pickedPeople.map((person) => person.key))))
  }

  return (
    <>
      <fieldset className={styles.people} disabled={running}>
        <legend className={styles.peopleLegend}>People</legend>
        {manifest.people.map((person) => (
          <Checkbox
            key={person.key}
            checked={!unpickedKeys.has(person.key)}
            label={<PersonLabel person={person} />}
            onChange={(picked) => {
              setPicked(person.key, picked)
            }}
          />
        ))}
      </fieldset>
      <div className={styles.actions}>
        <button
          type="button"
          className="button-2 filled"
          disabled={running || pickedPeople.length === 0}
          onClick={startLoad}
        >
          Load into {serverUrl}
        </button>
        {(load._tag === 'loaded' || load._tag === 'failed') && (
          <button type="button" className="button-2 outline" onClick={reset}>
            Clear results
          </button>
        )}
      </div>
      {isRunning(load) && <LoadProgress load={load} />}
      {load._tag === 'failed' && <ReadFailureLine subject="the data set" error={load.reason} />}
      {load._tag === 'loaded' && (
        <LoadResults
          outcomes={load.outcomes}
          peopleNames={loadedPeopleNames}
          serverUrl={serverUrl}
        />
      )}
    </>
  )
}

/** The people of the data set at `root`, once its manifest is read. */
const DataSetPeople = ({
  root,
  serverUrl,
  fetchUrl,
  loader,
}: {
  readonly root: URL
  readonly serverUrl: string
  readonly fetchUrl: Fetch
  readonly loader: DataSetLoader
}): JSX.Element => {
  const manifest = useQuery({
    queryKey: [MANIFEST_QUERY_KEY, root.href],
    queryFn: () =>
      Effect.runPromise(Effect.either(readManifest(root, fetchUrl))).then(
        Either.getOrThrowWith(Fn.identity)
      ),
    // A static host's missing or malformed index.json is not transient; the
    // reader reads it again with the form, which resets this query.
    retry: false,
  })
  if (manifest.isError) return <ReadFailureLine subject="the data set" error={manifest.error} />
  if (manifest.data === undefined) return <LoadingLine subject="the data set" />
  return <PeopleLoad root={root} manifest={manifest.data} serverUrl={serverUrl} loader={loader} />
}

/** Props for {@link SyntheticDataScreen}. */
interface SyntheticDataScreenProps {
  /** The FHIR server a load writes to, as the reader knows it (the SMART server URL). */
  readonly serverUrl: string
  /** The data set's root, as typed or passed; an invalid one is reported, not read. */
  readonly dataSetUrl: string
  /** Called with the URL the reader submits, which may be the one already read. */
  readonly onDataSetUrlChange: (dataSetUrl: string) => void
  /** How the data set's files are fetched; `globalThis.fetch` by default. */
  readonly fetchUrl?: Fetch
}

/**
 * Load people from a published synthetic data set into the FHIR server the
 * app is connected to.
 *
 * @remarks
 * Reads the manifest at `dataSetUrl`, lists its people (all picked), and on
 * "Load into …" reads the picked people's files and writes them in batch
 * bundles through the router context's `runAuthed`, then shows each
 * resource's result. The data set URL is the caller's state; submitting the
 * form reads the data set again even when the URL is unchanged. The form is
 * locked while a load runs, so the load and its results stay on screen.
 */
const SyntheticDataScreen = ({
  serverUrl,
  dataSetUrl,
  onDataSetUrlChange,
  fetchUrl = fetchFromWindow,
}: SyntheticDataScreenProps): JSX.Element => {
  const queryClient = useQueryClient()
  const loader = useDataSetLoad(fetchUrl)
  const root = dataSetRootOf(dataSetUrl)
  const submitDataSetUrl = (submittedUrl: string): void => {
    loader.reset()
    void queryClient.resetQueries({ queryKey: [MANIFEST_QUERY_KEY] })
    onDataSetUrlChange(submittedUrl)
  }
  return (
    <div className={styles.screen}>
      <DataSetForm
        dataSetUrl={dataSetUrl}
        disabled={isRunning(loader.load)}
        onDataSetUrlSubmit={submitDataSetUrl}
      />
      {Either.isLeft(root) ? (
        <p role="alert" className={styles.invalid}>
          {root.left.reason}
        </p>
      ) : (
        <DataSetPeople
          key={root.right.href}
          root={root.right}
          serverUrl={serverUrl}
          fetchUrl={fetchUrl}
          loader={loader}
        />
      )}
    </div>
  )
}

export { SyntheticDataScreen }
export type { SyntheticDataScreenProps }
