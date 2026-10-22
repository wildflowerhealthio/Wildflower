/**
 * The attribute a page control carries to be a walkthrough step's anchor; its
 * value is the step's {@link WalkthroughStep.anchor}.
 */
const WALKTHROUGH_ANCHOR_ATTRIBUTE = 'data-walkthrough'

/** One popover of a walkthrough, pointing at a control on the page. */
interface WalkthroughStep {
  /**
   * The {@link WALKTHROUGH_ANCHOR_ATTRIBUTE} value of the control the popover
   * points at, set on it with {@link walkthroughAnchor}.
   */
  readonly anchor: string
  /** The popover's heading, as plain text. */
  readonly title: string
  /** What the popover says about the control, as plain text. */
  readonly body: string
}

/**
 * The props that make an element the anchor `anchor` names, to spread onto it.
 *
 * @example
 * ```tsx
 * <button {...walkthroughAnchor('add-server')}>Add server</button>
 * ```
 */
const walkthroughAnchor = (
  anchor: string
): Readonly<Record<typeof WALKTHROUGH_ANCHOR_ATTRIBUTE, string>> => ({
  [WALKTHROUGH_ANCHOR_ATTRIBUTE]: anchor,
})

export type { WalkthroughStep }
export { WALKTHROUGH_ANCHOR_ATTRIBUTE, walkthroughAnchor }
