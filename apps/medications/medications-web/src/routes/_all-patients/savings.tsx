import { createFileRoute } from '@tanstack/react-router'

import { SavingsTab } from '../-tabs/savings/savings-tab.tsx'

/** `/savings`, every patient's Savings tab. */
const Route = createFileRoute('/_all-patients/savings')({
  component: SavingsTab,
})

export { Route }
