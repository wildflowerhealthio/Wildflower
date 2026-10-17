import { createFileRoute } from '@tanstack/react-router'

import { MedicationsTab } from '../../-tabs/medications/medications-tab.tsx'

/** `/patients/$patientId/medications`, the patient's Medications tab, which their page opens on. */
const Route = createFileRoute('/patients/$patientId/medications')({
  component: MedicationsTab,
})

export { Route }
