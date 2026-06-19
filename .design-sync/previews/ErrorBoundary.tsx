import { ErrorBoundary } from 'react-tundraish'

/** A child that always throws — used to drive the boundary into its caught state. */
const Boom = (): never => {
  throw new Error('Render failed while loading the dashboard.')
}

/**
 * The caught state — what the user sees after a child throws: a heading, the
 * `name: message` summary line, Copy details / Reload buttons, and collapsed
 * `<details>` panes for the stacks and context. The preview renders a child
 * that throws on mount so the boundary shows this fallback (its resting state
 * is just `children`, which a static preview can't tell apart from no
 * boundary at all).
 */
export const Caught = () => (
  <div style={{ maxWidth: 520 }}>
    <ErrorBoundary title="Something went wrong" headingLevel={2}>
      <Boom />
    </ErrorBoundary>
  </div>
)
