import { LinkButton } from '@wildflowerhealthio/react-tundraish'

/**
 * Link-text action at the end of a compact status line — the smart-app
 * patient-choice line ("Showing … · Change patient").
 */
export const InStatusLine = () => (
  <div className="text-body-3" style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
    <span>
      Showing medications for <strong>Maria Hernández</strong>
    </span>
    <LinkButton onClick={() => {}}>Change patient</LinkButton>
  </div>
)

/** Inside prose, where a boxed button would overpower the copy. */
export const InProse = () => (
  <p className="text-body-2" style={{ maxWidth: 420 }}>
    Interactions are checked against every medication at once.{' '}
    <LinkButton onClick={() => {}}>Load the rest of my medications</LinkButton>
  </p>
)
