import { createFileRoute } from '@tanstack/react-router'

import { MedicationsTab } from '../-tabs/medications/medications-tab.tsx'

/** `/medications`, every patient's Medications tab, which All patients opens on. */
const Route = createFileRoute('/_all-patients/medications')({
  component: MedicationsTab,
})

export { Route }
