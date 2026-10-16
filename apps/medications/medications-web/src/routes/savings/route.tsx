import { createFileRoute } from '@tanstack/react-router'
import type { Medication, Province } from '@wildflowerhealthio/medication-sponsorship-core-js'
import { SavingsView } from '@wildflowerhealthio/medication-sponsorship-react'
import { type JSX, useMemo } from 'react'

import { useCurrentMedications, useMedicationRead } from '../-medication-read.ts'
import { PartialListBanner } from '../-partial-list-banner.tsx'
import { usePageState } from '../../router-context.ts'
import { catalogs } from './-catalogs.ts'
import { pastEligibleMedications } from './-past-medications.ts'

/** What the Savings tab breaks down, and for which province. */
interface SavingsTabModel {
  readonly currentMedications: readonly Medication[]
  readonly pastMedications: readonly Medication[]
  readonly province: Province
  readonly chooseProvince: (province: Province) => void
}

/**
 * The Savings tab's logic: the current medications, the completed
 * prescriptions still eligible for a program (shown below them), and the
 * province, which the page keeps as the reader changes tabs.
 */
const useSavingsTab = (): SavingsTabModel => {
  const { views } = useMedicationRead()
  const [province, updatePageState] = usePageState((state) => state.province)
  return {
    currentMedications: useCurrentMedications(views),
    pastMedications: useMemo(() => pastEligibleMedications(views), [views]),
    province,
    chooseProvince: (chosen) => {
      updatePageState({ province: chosen })
    },
  }
}

/**
 * The Savings tab: the savings-program breakdown of the current medications,
 * with its province picker, under the partial-list banner while the list is
 * incomplete.
 */
function SavingsTab(): JSX.Element {
  const { currentMedications, pastMedications, province, chooseProvince } = useSavingsTab()
  return (
    <>
      <PartialListBanner />
      <SavingsView
        medications={currentMedications}
        pastMedications={pastMedications}
        province={province}
        onProvinceChange={chooseProvince}
        catalogs={catalogs}
      />
    </>
  )
}

/** `/savings`, the Savings tab. */
const Route = createFileRoute('/savings')({
  component: SavingsTab,
})

export { Route }
