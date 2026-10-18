import { createFileRoute } from '@tanstack/react-router'
import { StrongLifts5x5 } from '@wildflowerhealthio/strength-core-js'
import { Array as Arr, Match } from 'effect'
import type { JSX } from 'react'

import { LifterTab } from '../-lifter-tab.tsx'
import { useStrengthContext } from '../../../../router-context.ts'
import { StartProgram } from '../../../../start-program/start-program.tsx'
import { WorkoutDue } from './-workout-due.tsx'

/**
 * The Today tab: the workout due under the lifter's current program, or, with
 * none, a start of the StrongLifts 5×5 template at its starting loads.
 */
function TodayTab(): JSX.Element {
  const { strongLiftsPlanDefinitionIdFor } = useStrengthContext()
  return (
    <LifterTab>
      {({ session, trainingRecord }) =>
        Match.value(trainingRecord.current).pipe(
          Match.tag('Some', ({ value: currentTraining }) => (
            <WorkoutDue
              session={session}
              currentTraining={currentTraining}
              activeExerciseRequests={trainingRecord.activeExerciseRequests}
            />
          )),
          Match.tag('None', () => (
            <StartProgram
              session={session}
              trainingPlanDefinitions={Arr.of(
                StrongLifts5x5.trainingPlanDefinition(
                  strongLiftsPlanDefinitionIdFor(session.patientId)
                )
              )}
              storesTrainingPlanDefinition
              suggestedStartingLoads={StrongLifts5x5.STARTING_LOADS}
              activeExerciseRequests={trainingRecord.activeExerciseRequests}
            />
          )),
          Match.exhaustive
        )
      }
    </LifterTab>
  )
}

/** `/patients/$patientId/today`, the lifter's Today tab. */
const Route = createFileRoute('/patients/$patientId/today')({
  component: TodayTab,
})

export { Route }
