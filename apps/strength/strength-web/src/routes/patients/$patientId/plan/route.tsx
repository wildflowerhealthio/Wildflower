import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Option } from 'effect'
import type { JSX } from 'react'

import { LifterTab } from '../-lifter-tab.tsx'
import { PlanEditor } from './-plan-editor.tsx'

/**
 * The Plan tab: the editor over the lifter's current program, which opens
 * Today once the program it saved has started.
 */
function PlanTab(): JSX.Element {
  const { patientId } = Route.useParams()
  const navigate = useNavigate()
  return (
    <LifterTab>
      {({ session, trainingRecord }) => {
        const currentTrainingPlanDefinition = Option.map(
          trainingRecord.current,
          ({ trainingPlanDefinition }) => trainingPlanDefinition
        )
        return (
          <PlanEditor
            // Re-seeded when the program it edits changes.
            key={Option.match(currentTrainingPlanDefinition, {
              onNone: () => 'none',
              onSome: ({ id }) => id,
            })}
            session={session}
            currentTrainingPlanDefinition={currentTrainingPlanDefinition}
            activeExerciseRequests={trainingRecord.activeExerciseRequests}
            onStarted={() => {
              // As the Today tab's own link would: in place of Plan in history.
              void navigate({
                to: '/patients/$patientId/today',
                params: { patientId },
                replace: true,
              })
            }}
          />
        )
      }}
    </LifterTab>
  )
}

/** `/patients/$patientId/plan`, the lifter's Plan tab. */
const Route = createFileRoute('/patients/$patientId/plan')({
  component: PlanTab,
})

export { Route }
