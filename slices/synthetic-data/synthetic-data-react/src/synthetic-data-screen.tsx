import { skipToken, useQuery } from '@tanstack/react-query'
import { DateTime, Effect, Either, Match } from 'effect'
import { type SubmitEvent, type JSX, useState } from 'react'
import { Checkbox, ErrorBanner, FieldGroup, TextField } from 'react-tundraish'
import { LoadingLine, ReadFailureLine } from 'smart-app-react'
import { DataSet, DataSetManifest } from 'synthetic-data-core'

import { countOf } from './count-of.ts'
import { dataSetRootOf, fetchedFileSource } from './data-set-files.ts'
import { LoadResults } from './load-results.tsx'
import { isLoadRunning, type LoadState, useDataSetLoad } from './use-data-set-load.ts'
import styles from './synthetic-data-screen.module.css'

/** The query key a data set's manifest is read under, by its root. */
const manifestQueryKey = (root: URL | undefined): readonly string[] => [
  'synthetic-data',
  'manifest',
  root?.href ?? '',
]

/** How many characters of the generating commit the data set line shows. */
const SHORT_COMMIT_LENGTH = 12

/** The data set line: its as-of day, its size, and the Wildflower commit it was generated at. */
const DataSetLine = ({ manifest }: { readonly manifest: DataSetManifest.Type }): JSX.Element => (
  <p className={styles.dataSetLine}>
    As of {DateTime.formatIsoDateUtc(manifest.asOf)} ·{' '}
    {countOf(manifest.totals.people, 'person', 'people')} ·{' '}
    {countOf(manifest.totals.resources, 'resource')} ·{' '}
    {countOf(manifest.totals.staticFiles, 'source file')} · generated at Wildflower{' '}
    <code>{manifest.generator.wildflowerCommit.slice(0, SHORT_COMMIT_LENGTH)}</code>
  </p>
)

/** One person to choose: their name, their summary, and how many resources are theirs. */
const PersonLabel = ({
  person,
}: {
  readonly person: DataSetManifest.Type['people'][number]
}): JSX.Element => (
  <span className={styles.person}>
    <span className={styles.personName}>{person.displayName}</span>
    {person.summary !== '' && <span className={styles.personSummary}>{person.summary}</span>}
    <span className={styles.personCount}>{countOf(person.resources.length, 'resource')}</span>
  </span>
)

/**
 * One person's checkbox: checked to load them, and disabled while a load
 * runs, when there is no `onToggle`.
 */
const PersonCheckbox = ({
  person,
  checked,
  onToggle,
}: {
  readonly person: DataSetManifest.Type['people'][number]
  readonly checked: boolean
  readonly onToggle: ((key: string, loaded: boolean) => void) | undefined
}): JSX.Element =>
  onToggle === undefined ? (
    <Checkbox checked={checked} label={<PersonLabel person={person} />} disabled />
  ) : (
    <Checkbox
      checked={checked}
      label={<PersonLabel person={person} />}
      onChange={(loaded) => {
        onToggle(person.key, loaded)
      }}
    />
  )

/** The load's progress, or why it stopped, while it is not showing results. */
const LoadStatus = ({ state }: { readonly state: LoadState }): JSX.Element | null =>
  Match.valueTags(state, {
    reading: ({ read, total }) => (
      <p role="status" className={styles.status}>
        Reading files… {read} of {total}
      </p>
    ),
    writing: ({ written, total }) => (
      <p role="status" className={styles.status}>
        Writing resources… {written} of {total}
      </p>
    ),
    unreadable: ({ failures }) => (
      <div role="alert" className={styles.unreadable}>
        <p>Nothing was written: {countOf(failures.length, 'file')} could not be read.</p>
        <ul className={styles.failures}>
          {failures.map((failure) => (
            <li key={failure.path}>
              <code>{failure.path}</code> {failure.reason}
            </li>
          ))}
        </ul>
      </div>
    ),
    failed: ({ error }) => <ErrorBanner error={error} />,
    idle: () => null,
    done: () => null,
  })

/** Props for {@link SyntheticDataScreen}. */
interface SyntheticDataScreenProps {
  /** The data set address the form starts with, and reads on mount. */
  readonly initialDataSetAddress: string
}

/**
 * Load a published synthetic data set into the connected FHIR server: read
 * its `index.json` from the address typed, choose its people (all, to begin
 * with), and load them — every chosen file fetched and read back first, then
 * written in reference order, with every resource's outcome shown after.
 *
 * @remarks
 * The FHIR server is the route context's (`fhir-r4-react`'s `useRunAuthed`),
 * so mount the screen under the host app's router and `QueryClientProvider`.
 * The data set's files are fetched from their own host, without
 * credentials. The address and the people are locked while a load runs.
 */
const SyntheticDataScreen = ({ initialDataSetAddress }: SyntheticDataScreenProps): JSX.Element => {
  const [address, setAddress] = useState(initialDataSetAddress)
  const [addressProblem, setAddressProblem] = useState<string | undefined>(undefined)
  const [root, setRoot] = useState<URL | undefined>(() =>
    Either.getOrUndefined(dataSetRootOf(initialDataSetAddress))
  )
  // The people left out; everyone else in the data set is loaded.
  const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(new Set())
  const { state, load, reset } = useDataSetLoad()
  const running = isLoadRunning(state)

  const manifest = useQuery({
    queryKey: manifestQueryKey(root),
    queryFn:
      root === undefined
        ? skipToken
        : () => Effect.runPromise(DataSet.readManifest(fetchedFileSource(root))),
    // A static host answers a second request as it answered the first.
    retry: false,
  })

  const readAddress = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    Either.match(dataSetRootOf(address), {
      onLeft: setAddressProblem,
      onRight: (nextRoot) => {
        setAddressProblem(undefined)
        reset()
        if (nextRoot.href === root?.href) {
          void manifest.refetch()
          return
        }
        setLeftOut(new Set())
        setRoot(nextRoot)
      },
    })
  }

  const toggle = (key: string, loaded: boolean): void => {
    setLeftOut((current) => {
      const next = new Set(current)
      if (loaded) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const chosenKeys =
    manifest.data === undefined
      ? new Set<string>()
      : new Set(manifest.data.people.map((person) => person.key).filter((key) => !leftOut.has(key)))

  const startLoad = (): void => {
    if (root === undefined || manifest.data === undefined) return
    load(root, DataSetManifest.filesOf(manifest.data, chosenKeys).resources)
  }

  return (
    <div className={styles.screen}>
      <form className={styles.addressForm} onSubmit={readAddress} noValidate>
        <TextField
          label="Data set"
          value={address}
          onChange={setAddress}
          inputMode="url"
          autoCapitalize="none"
          disabled={running}
          description="The address of a published data set: the folder its index.json is in."
        />
        {addressProblem !== undefined && (
          <p role="alert" className={styles.problem}>
            {addressProblem}
          </p>
        )}
        <div>
          <button type="submit" className="button-2" disabled={running}>
            Read data set
          </button>
        </div>
      </form>

      {manifest.isFetching && <LoadingLine subject="the data set" />}
      {!manifest.isFetching && manifest.isError && (
        <ReadFailureLine subject="the data set" error={manifest.error} />
      )}

      {manifest.data !== undefined && !manifest.isFetching && (
        <section aria-label="Data set" className={styles.dataSet}>
          <DataSetLine manifest={manifest.data} />
          <FieldGroup label="People to load">
            {manifest.data.people.map((person) => (
              <PersonCheckbox
                key={person.key}
                person={person}
                checked={chosenKeys.has(person.key)}
                onToggle={running ? undefined : toggle}
              />
            ))}
          </FieldGroup>
          {state._tag === 'done' ? (
            <LoadResults outcomes={state.outcomes} onDone={reset} />
          ) : (
            <div>
              <button
                type="button"
                className="button-2 filled"
                disabled={running || chosenKeys.size === 0}
                onClick={startLoad}
              >
                Load {countOf(chosenKeys.size, 'person', 'people')}
              </button>
            </div>
          )}
          <LoadStatus state={state} />
        </section>
      )}
    </div>
  )
}

export { SyntheticDataScreen, type SyntheticDataScreenProps }
