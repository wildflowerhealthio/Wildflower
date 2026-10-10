import { PartialBanner } from '@wildflowerhealthio/react-tundraish'

/** The still-filling-in state: amber breathing dot and one line of copy. */
export const StillLoading = () => (
  <div style={{ maxWidth: 520 }}>
    <PartialBanner>
      Partial list — still loading. Interactions with medications that haven&apos;t loaded yet are
      missing.
    </PartialBanner>
  </div>
)

/** A page failed — the inline link-text action re-requests it. */
export const WithRetry = () => (
  <div style={{ maxWidth: 520 }}>
    <PartialBanner action={{ label: 'Retry', onClick: () => {} }}>
      A page of your medication list failed to load. Interactions with the medications that
      haven&apos;t loaded yet are missing.
    </PartialBanner>
  </div>
)

/** Paused partial data with a load-the-rest affordance. */
export const LoadTheRest = () => (
  <div style={{ maxWidth: 520 }}>
    <PartialBanner action={{ label: 'Load all the rest', onClick: () => {} }}>
      Showing the 200 most recent workouts.
    </PartialBanner>
  </div>
)
