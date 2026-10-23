import { useNavigate, useSearch } from '@tanstack/react-router'
import type { WalkthroughStep } from '@wildflowerhealthio/walkthrough-core'
import { useWalkthrough, type WalkthroughPrompt } from '@wildflowerhealthio/walkthrough-react'
import { Schema } from 'effect'

/** The Medications walkthrough's id, naming its record in the page's `localStorage`. */
const MEDICATIONS_WALKTHROUGH_ID = 'medications'

/** The version of {@link MEDICATIONS_WALKTHROUGH_STEPS}; raising it shows the walkthrough again. */
const MEDICATIONS_WALKTHROUGH_VERSION = 1

/** The `data-walkthrough` values of the medications page's controls the walkthrough points at. */
const MedicationsWalkthroughAnchor = {
  patientLine: 'patient-line',
  medicationsTab: 'medications-tab',
  calendarTab: 'calendar-tab',
  interactionsTab: 'interactions-tab',
  savingsTab: 'savings-tab',
} as const

/**
 * The Medications walkthrough, in page order: the patient line, then the
 * tabs, which are on the page whichever tab is open. All patients has no
 * Interactions tab, so its step shows on one patient's page only.
 */
const MEDICATIONS_WALKTHROUGH_STEPS: ReadonlyArray<WalkthroughStep> = [
  {
    anchor: MedicationsWalkthroughAnchor.patientLine,
    title: 'Change patient',
    body: "This line names whose medications you're looking at: one patient, or All patients. Select Change patient to choose someone else.",
  },
  {
    anchor: MedicationsWalkthroughAnchor.medicationsTab,
    title: 'Medications',
    body: 'Your active medications come first, then completed ones. Each shows the repeats left on it and who prescribed it.',
  },
  {
    anchor: MedicationsWalkthroughAnchor.calendarTab,
    title: 'Calendar',
    body: "The calendar shows when to pick up your next refill, when to book an appointment to renew a prescription, and when a supply runs out. On a small screen it's a list of days around a red Now line.",
  },
  {
    anchor: MedicationsWalkthroughAnchor.interactionsTab,
    title: 'Interactions',
    body: 'This checks your current medications against each other, common over-the-counter drugs, and food, alcohol and other non-drugs. Each dot on a card is one interaction, coloured by how severe it is.',
  },
  {
    anchor: MedicationsWalkthroughAnchor.savingsTab,
    title: 'Savings',
    body: 'This lists the programs that may help pay for your current medications in the province you pick. Show walkthrough again, at the bottom of the page, brings these steps back.',
  },
]

/**
 * The medications page's search: `walkthrough=show` is the page's Show
 * walkthrough again link, which shows the walkthrough whatever its record says.
 */
const MedicationsPageSearch = Schema.Struct({
  walkthrough: Schema.optional(Schema.Literal('show')),
})
type MedicationsPageSearch = typeof MedicationsPageSearch.Type

/** The medications page's search that shows the walkthrough again. */
const SHOW_WALKTHROUGH_AGAIN_SEARCH: MedicationsPageSearch = { walkthrough: 'show' }

/**
 * Whether the medications page shows the Medications walkthrough, kept in
 * the page's `localStorage`, and how the visitor leaves it.
 *
 * @remarks
 * It shows on a first visit, while no record for
 * {@link MEDICATIONS_WALKTHROUGH_VERSION} is kept, and whenever the page's
 * search asks for it. Finishing or skipping records the outcome, and
 * postponing (no step's control on the page) records nothing; each drops
 * that search, replacing the history entry and staying on the open tab, so
 * Back doesn't show it again.
 */
const useMedicationsWalkthrough = (): Pick<
  WalkthroughPrompt,
  'open' | 'finish' | 'skip' | 'postpone'
> => {
  const prompt = useWalkthrough({
    storage: window.localStorage,
    id: MEDICATIONS_WALKTHROUGH_ID,
    version: MEDICATIONS_WALKTHROUGH_VERSION,
  })
  // The page is one patient's or every patient's, so the search is read from
  // whichever of the two routes is open; both validate it the same way.
  const showAgain = useSearch({ strict: false, select: (search) => search.walkthrough })
  const navigate = useNavigate()
  const dropShowAgain = (): void => {
    if (showAgain === undefined) return
    void navigate({
      to: '.',
      search: (previous) => ({ ...previous, walkthrough: undefined }),
      replace: true,
    })
  }
  return {
    open: prompt.open || showAgain === 'show',
    finish: () => {
      prompt.finish()
      dropShowAgain()
    },
    skip: () => {
      prompt.skip()
      dropShowAgain()
    },
    postpone: () => {
      prompt.postpone()
      dropShowAgain()
    },
  }
}

export {
  MEDICATIONS_WALKTHROUGH_ID,
  MEDICATIONS_WALKTHROUGH_STEPS,
  MEDICATIONS_WALKTHROUGH_VERSION,
  MedicationsPageSearch,
  MedicationsWalkthroughAnchor,
  SHOW_WALKTHROUGH_AGAIN_SEARCH,
  useMedicationsWalkthrough,
}
