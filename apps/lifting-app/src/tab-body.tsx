import { Array as Arr, Match, Option } from 'effect'
import { StrongLifts5x5 } from 'lifting-core'
import type { JSX } from 'react'

import type { TrainingRecord } from './lifting-record.ts'
import type { LiftingSession } from './lifting-session.ts'
import { PlanTab } from './plan-tab.tsx'
import { StartProgram } from './start-program.tsx'
import { TodayTab } from './today-tab.tsx'

/** The three tabs the header toggle switches between. */
type Tab = 'today' | 'plan' | 'history'

/**
 * The tab shown over a training record: the workout due (or, with no current
 * program, a start of the StrongLifts 5×5 template at its starting loads), or
 * the program editor.
 */
const TabBody = ({
  tab,
  session,
  trainingRecord,
  strongLiftsPlanDefinitionId,
  onStarted,
}: {
  readonly tab: Exclude<Tab, 'history'>
  readonly session: LiftingSession
  readonly trainingRecord: TrainingRecord
  /** The id the StrongLifts 5×5 template is stored under if it is started. */
  readonly strongLiftsPlanDefinitionId: string
  /** Called once the plan tab has started a program. */
  readonly onStarted: () => void
}): JSX.Element =>
  Match.value(tab).pipe(
    Match.when('today', () =>
      Option.isSome(trainingRecord.current) ? (
        <TodayTab
          session={session}
          currentTraining={trainingRecord.current.value}
          activeExerciseRequests={trainingRecord.activeExerciseRequests}
        />
      ) : (
        <StartProgram
          session={session}
          trainingPlanDefinitions={Arr.of(
            StrongLifts5x5.trainingPlanDefinition(strongLiftsPlanDefinitionId)
          )}
          storesTrainingPlanDefinition
          suggestedStartingLoads={StrongLifts5x5.STARTING_LOADS}
          activeExerciseRequests={trainingRecord.activeExerciseRequests}
        />
      )
    ),
    Match.when('plan', () => {
      const currentTrainingPlanDefinition = Option.map(
        trainingRecord.current,
        ({ trainingPlanDefinition }) => trainingPlanDefinition
      )
      return (
        <PlanTab
          // Re-seeded when the program it edits changes.
          key={Option.match(currentTrainingPlanDefinition, {
            onNone: () => 'none',
            onSome: ({ id }) => id,
          })}
          session={session}
          currentTrainingPlanDefinition={currentTrainingPlanDefinition}
          activeExerciseRequests={trainingRecord.activeExerciseRequests}
          onStarted={onStarted}
        />
      )
    }),
    Match.exhaustive
  )

export { type Tab, TabBody }
