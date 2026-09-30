import { Either, ParseResult, Schema } from 'effect'
import { ReturnTarget } from 'pebble-configuration'
import { useState, type SubmitEvent, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner } from 'react-tundraish'
import { LiftSettings, Lifts } from 'watch-lifts-core'

import styles from './weights-page.module.css'

/** Why the page will not hand the weights off to a foreign `return_to`, in the user's terms. */
const FOREIGN_RETURN_TARGET_MESSAGE =
  'This page was opened with a return address that is not the Pebble app, so it will ' +
  "not send your weights there. Open it again from the watchapp's settings."

/** One cell of the table: a person and an exercise, as indexes into `Lifts`. */
interface Cell {
  readonly person: number
  readonly exercise: number
}

/** A cell's person and exercise by name, as the page labels and reports it. */
const cellName = ({ person, exercise }: Cell): string =>
  `${Lifts.PEOPLE[person] ?? ''}'s ${Lifts.EXERCISES[exercise] ?? ''}`

/**
 * A cell's text as a number for the Schema to check: the whole number it
 * spells, or `NaN`, which the Schema refuses, when it is anything but digits.
 * `Number` alone would read `''` as 0 and `'1e2'` as 100.
 */
const parseCell = (text: string): number => {
  const trimmed = text.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
}

/** Checks the table's numbers against `LiftSettings.Schema`, reporting every bad cell. */
const decodeWeights = Schema.decodeUnknownEither(LiftSettings.Schema, { errors: 'all' })

/** Every cell of the table, in table order: exercise by exercise, each person's in turn. */
const ALL_CELLS: ReadonlyArray<Cell> = Lifts.EXERCISES.flatMap((_, exercise) =>
  Lifts.PEOPLE.map((__, person) => ({ person, exercise }))
)

/** The cells a failed decode of the table blames, each once, in table order. */
const invalidCells = (error: ParseResult.ParseError): ReadonlyArray<Cell> => {
  const blamed = new Set<string>()
  for (const { path } of ParseResult.ArrayFormatter.formatErrorSync(error)) {
    const [field, person, exercise] = path
    if (field === 'weights' && typeof person === 'number' && typeof exercise === 'number') {
      blamed.add(`${person}/${exercise}`)
    }
  }
  return ALL_CELLS.filter(({ person, exercise }) => blamed.has(`${person}/${exercise}`))
}

/** The banner naming the cells that stopped the save. */
const invalidMessage = (cells: ReadonlyArray<Cell>): string =>
  `Each weight must be a whole number of pounds from 0 to ${Lifts.MAX_WEIGHT}. ` +
  `Check ${cells.map(cellName).join(', ')}.`

/** Props for {@link WeightsForm}. */
interface WeightsFormProps {
  /** The weights the table starts from. */
  readonly settings: LiftSettings.Type
  /** Where the save hands the weights back to. */
  readonly returnTarget: ReturnTarget.Type
  /** Leaves the page for the hand-off URL. */
  readonly navigate: (url: string) => void
}

/**
 * The table of weights, one row per exercise and one column per person, and
 * the save that hands them to the Pebble phone app.
 *
 * @remarks
 * Each cell is free text, so a half-typed value is never rewritten under the
 * user. Save checks the whole table against `LiftSettings.Schema`; a bad cell
 * shows a banner naming it and saves nothing.
 */
const WeightsForm = ({ settings, returnTarget, navigate }: WeightsFormProps): JSX.Element => {
  const [cells, setCells] = useState<ReadonlyArray<ReadonlyArray<string>>>(() =>
    settings.weights.map((row) => row.map(String))
  )
  const [invalid, setInvalid] = useState<ReadonlyArray<Cell>>([])

  const setCell = ({ person, exercise }: Cell, text: string): void => {
    setCells((current) =>
      current.map((row, p) => (p === person ? row.map((t, e) => (e === exercise ? text : t)) : row))
    )
  }

  const save = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    Either.match(decodeWeights({ weights: cells.map((row) => row.map(parseCell)) }), {
      onLeft: (error) => {
        setInvalid(invalidCells(error))
      },
      onRight: (weights) => {
        setInvalid([])
        navigate(ReturnTarget.handoffUrl(returnTarget, LiftSettings.toJson(weights)))
      },
    })
  }

  const isInvalid = (cell: Cell): boolean =>
    invalid.some(({ person, exercise }) => person === cell.person && exercise === cell.exercise)

  return (
    <form className={styles['form']} onSubmit={save} noValidate>
      <ErrorBanner error={invalid.length > 0 ? invalidMessage(invalid) : null} />
      <table className={cn(styles['table'], 'text-body-3')}>
        <thead>
          <tr>
            <th scope="col">Exercise</th>
            {Lifts.PEOPLE.map((name) => (
              <th key={name} scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Lifts.EXERCISES.map((exerciseName, exercise) => (
            <tr key={exerciseName}>
              <th scope="row">{exerciseName}</th>
              {Lifts.PEOPLE.map((personName, person) => (
                <td key={personName}>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    className={cn('input-2', styles['weight'])}
                    aria-label={`${cellName({ person, exercise })} weight, lbs`}
                    aria-invalid={isInvalid({ person, exercise })}
                    value={cells[person]?.[exercise] ?? ''}
                    onChange={(event): void => {
                      setCell({ person, exercise }, event.target.value)
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <button type="submit" className="button-2">
          Save to watch
        </button>
      </div>
    </form>
  )
}

/** Props for {@link WeightsPage}. */
interface WeightsPageProps {
  /** The weights the page was opened with, or the defaults. */
  readonly settings: LiftSettings.Type
  /** The Pebble phone app's `return_to`, or why the page will not hand off to it. */
  readonly returnTarget: Either.Either<ReturnTarget.Type, ReturnTarget.ForeignReturnTargetError>
  /** Leaves the page for the hand-off URL. */
  readonly navigate: (url: string) => void
}

/**
 * The settings page the Pebble phone app shows for WatchLifts: every person's
 * weight at every exercise, and the save that sends them to the watch — or,
 * when the page was opened with a `return_to` that is not the Pebble app, a
 * refusal and no save.
 */
const WeightsPage = ({ settings, returnTarget, navigate }: WeightsPageProps): JSX.Element => (
  <main className={styles['page']}>
    <header className={styles['header']}>
      <h1 className="text-heading-3">WatchLifts weights</h1>
      <p className={cn(styles['subtitle'], 'text-body-3')}>
        Each person&apos;s weight at each exercise, in pounds. Save sends them to the watch.
      </p>
    </header>

    {Either.match(returnTarget, {
      // oxlint-disable-next-line react/no-unstable-nested-components
      onLeft: () => <ErrorBanner error={FOREIGN_RETURN_TARGET_MESSAGE} />,
      // oxlint-disable-next-line react/no-unstable-nested-components
      onRight: (target) => (
        <WeightsForm settings={settings} returnTarget={target} navigate={navigate} />
      ),
    })}
  </main>
)

export { WeightsPage, type WeightsPageProps }
