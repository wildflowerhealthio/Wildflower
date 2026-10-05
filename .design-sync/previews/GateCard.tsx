import { GateCard } from 'react-tundraish'

/** Waiting on a load the body depends on, with an escape hatch. */
export const Loading = () => (
  <GateCard
    title="Waiting for your full medication list"
    body="Interactions are checked against every medication at once — a partial list could miss one."
    action={{ label: 'Show me it live as it loads anyway', onClick: () => {} }}
  />
)

/** Spinner only — a one-time preparation step. */
export const Preparing = () => (
  <GateCard
    title="Preparing the interaction checker"
    body="Loading the interaction database — a one-time download for this visit."
  />
)

/** The paused variant (`showSpinner={false}`): nothing running, action resumes. */
export const Paused = () => (
  <GateCard
    title="Only part of your medication list is loaded"
    body="Interactions are checked against every medication at once — a partial list could miss one."
    showSpinner={false}
    action={{ label: 'Load the rest of my medications', onClick: () => {} }}
  />
)

/** A failed page — paused, with a retry. */
export const Failed = () => (
  <GateCard
    title="Couldn't load part of your list"
    body="A page of your medication list failed to load. Interactions stay paused until it arrives — retrying re-requests just that page."
    showSpinner={false}
    action={{ label: 'Retry', onClick: () => {} }}
  />
)
