import { skipToken, useQuery } from '@tanstack/react-query'
import { DateTime, Effect, Either, Match } from 'effect'
import { type SubmitEvent, type JSX, useState } from 'react'
import { Checkbox, ErrorBanner, FieldGroup, TextField } from 'react-tundraish'
import { LoadingLine, ReadFailureLine } from 'smart-app-react'
import { Snapshot } from 'synthetic-data-core'

import { countOf } from './count-of.ts'
import { LoadResults } from './load-results.tsx'
import { fetcherAt, snapshotRootOf } from './snapshot-files.ts'
import { isLoadRunning, type LoadState, useSnapshotLoad } from './use-snapshot-load.ts'
import styles from './synthetic-data-screen.module.css'

/** The query key a snapshot's header is read under, by its root. */
const headerQueryKey = (root: URL | undefined): readonly string[] => [
  'synthetic-data',
  'header',
  root?.href ?? '',
]

/** How many characters of the generating commit the snapshot line shows. */
const SHORT_COMMIT_LENGTH = 12

/** The snapshot line: its as-of day, its size, and the Wildflower commit it was generated at. */
const SnapshotLine = ({ header }: { readonly header: Snapshot.Header.Header }): JSX.Element => (
  <p className={styles['synthetic-data-screen__snapshot-line']}>
    As of {DateTime.formatIsoDateUtc(header.asOf)} ·{' '}
    {countOf(header.totals.people, 'person', 'people')} ·{' '}
    {countOf(header.totals.resources, 'resource')} ·{' '}
    {countOf(header.totals.staticFiles, 'source file')} · generated at Wildflower{' '}
    <code>{header.generator.wildflowerCommit.slice(0, SHORT_COMMIT_LENGTH)}</code>
  </p>
)

/** One member to choose: their name, their summary, and how many resources are theirs. */
const MemberLabel = ({
  member,
}: {
  readonly member: Snapshot.Header.MemberListing
}): JSX.Element => (
  <span className={styles['synthetic-data-screen__member']}>
    <span className={styles['synthetic-data-screen__member-name']}>{member.displayName}</span>
    {member.summary !== '' && (
      <span className={styles['synthetic-data-screen__member-summary']}>{member.summary}</span>
    )}
    <span className={styles['synthetic-data-screen__member-count']}>
      {countOf(member.resources.length, 'resource')}
    </span>
  </span>
)

/**
 * One member's checkbox: checked to load them, and disabled while a load
 * runs, when there is no `onToggle`.
 */
const MemberCheckbox = ({
  member,
  checked,
  onToggle,
}: {
  readonly member: Snapshot.Header.MemberListing
  readonly checked: boolean
  readonly onToggle: ((key: string, loaded: boolean) => void) | undefined
}): JSX.Element =>
  onToggle === undefined ? (
    <Checkbox checked={checked} label={<MemberLabel member={member} />} disabled />
  ) : (
    <Checkbox
      checked={checked}
      label={<MemberLabel member={member} />}
      onChange={(loaded) => {
        onToggle(member.key, loaded)
      }}
    />
  )

/** The load's progress, or why it stopped, while it is not showing results. */
const LoadStatus = ({ state }: { readonly state: LoadState }): JSX.Element | null =>
  Match.valueTags(state, {
    reading: ({ read, total }) => (
      <p role="status" className={styles['synthetic-data-screen__status']}>
        Reading files… {read} of {total}
      </p>
    ),
    writing: ({ written, total }) => (
      <p role="status" className={styles['synthetic-data-screen__status']}>
        Writing resources… {written} of {total}
      </p>
    ),
    unreadable: ({ failures }) => (
      <div role="alert" className={styles['synthetic-data-screen__unreadable']}>
        <p>Nothing was written: {countOf(failures.length, 'file')} could not be read.</p>
        <ul className={styles['synthetic-data-screen__failures']}>
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
  /** The snapshot address the form starts with, and reads on mount. */
  readonly initialSnapshotAddress: string
}

/**
 * Load a published synthetic data snapshot into the connected FHIR server:
 * read its `index.json` from the address typed, choose its members (all, to
 * begin with), and load them — every chosen file fetched and read back first, then
 * written in reference order, with every resource's outcome shown after.
 *
 * @remarks
 * The FHIR server is the route context's (`fhir-r4-react`'s `useRunAuthed`),
 * so mount the screen under the host app's router and `QueryClientProvider`.
 * The snapshot's files are fetched from their own host, without
 * credentials. The address and the members are locked while a load runs.
 */
const SyntheticDataScreen = ({ initialSnapshotAddress }: SyntheticDataScreenProps): JSX.Element => {
  const [address, setAddress] = useState(initialSnapshotAddress)
  const [addressProblem, setAddressProblem] = useState<string | undefined>(undefined)
  const [root, setRoot] = useState<URL | undefined>(() =>
    Either.getOrUndefined(snapshotRootOf(initialSnapshotAddress))
  )
  // The members left out; every other member of the snapshot is loaded.
  const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(new Set())
  const { state, load, reset } = useSnapshotLoad()
  const running = isLoadRunning(state)

  const header = useQuery({
    queryKey: headerQueryKey(root),
    queryFn:
      root === undefined
        ? skipToken
        : () => Effect.runPromise(Snapshot.Reader.readHeader(fetcherAt(root))),
    // A static host answers a second request as it answered the first.
    retry: false,
  })

  const readAddress = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    Either.match(snapshotRootOf(address), {
      onLeft: setAddressProblem,
      onRight: (nextRoot) => {
        setAddressProblem(undefined)
        reset()
        if (nextRoot.href === root?.href) {
          void header.refetch()
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
    header.data === undefined
      ? new Set<string>()
      : new Set(header.data.people.map((member) => member.key).filter((key) => !leftOut.has(key)))

  const startLoad = (): void => {
    if (root === undefined || header.data === undefined) return
    load(root, Snapshot.Header.pathsOf(header.data, chosenKeys).resources)
  }

  return (
    <div className={styles['synthetic-data-screen']}>
      <form
        className={styles['synthetic-data-screen__address-form']}
        onSubmit={readAddress}
        noValidate
      >
        <TextField
          label="Snapshot"
          value={address}
          onChange={setAddress}
          inputMode="url"
          autoCapitalize="none"
          disabled={running}
          description="The address of a published snapshot: the folder its index.json is in."
        />
        {addressProblem !== undefined && (
          <p role="alert" className={styles['synthetic-data-screen__problem']}>
            {addressProblem}
          </p>
        )}
        <div>
          <button type="submit" className="button-2" disabled={running}>
            Read snapshot
          </button>
        </div>
      </form>

      {header.isFetching && <LoadingLine subject="the snapshot" />}
      {!header.isFetching && header.isError && (
        <ReadFailureLine subject="the snapshot" error={header.error} />
      )}

      {header.data !== undefined && !header.isFetching && (
        <section aria-label="Snapshot" className={styles['synthetic-data-screen__snapshot']}>
          <SnapshotLine header={header.data} />
          <FieldGroup label="People to load">
            {header.data.people.map((member) => (
              <MemberCheckbox
                key={member.key}
                member={member}
                checked={chosenKeys.has(member.key)}
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
