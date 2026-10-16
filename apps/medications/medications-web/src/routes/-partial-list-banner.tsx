import { PartialBanner } from '@wildflowerhealthio/react-tundraish'
import { Match } from 'effect'
import type { JSX } from 'react'

import { type MedicationRead, useMedicationRead } from './-medication-read.ts'

/** What the banner says, and the action it offers, if any. */
interface PartialListNotice {
  readonly message: string
  readonly action?: { readonly label: string; readonly onClick: () => void }
}

/**
 * The banner's notice for `read`: a failed later page, with Retry; the rest
 * loading; or how many requests the list holds, offering to load them all.
 */
const partialListNoticeOf = ({
  pagedQuery,
  barPhase,
  views,
  requestEveryPage,
}: MedicationRead): PartialListNotice =>
  Match.value({ isFetchNextPageError: pagedQuery.isFetchNextPageError, barPhase }).pipe(
    Match.when({ isFetchNextPageError: true }, () => ({
      message:
        'A page of your medication list failed to load — this list is missing some of your medications.',
      action: { label: 'Retry', onClick: requestEveryPage },
    })),
    Match.when({ barPhase: 'loading' as const }, () => ({
      message: 'Loading the rest of your medications…',
    })),
    Match.orElse(() => ({
      message: `This list is loaded from your ${views.length} most recent medication requests,`,
      action: { label: 'load them all?', onClick: requestEveryPage },
    }))
  )

/**
 * The amber banner Calendar and Savings carry while the medication list is
 * incomplete, as they render from the pages loaded so far; nothing once it is
 * complete. A failed later page is surfaced here too (these tabs have no
 * inline error line of their own), with a retry in place of "load them all?".
 */
function PartialListBanner(): JSX.Element | null {
  const read = useMedicationRead()
  if (read.listComplete) return null
  const { message, action } = partialListNoticeOf(read)
  return <PartialBanner action={action}>{message}</PartialBanner>
}

export { PartialListBanner }
