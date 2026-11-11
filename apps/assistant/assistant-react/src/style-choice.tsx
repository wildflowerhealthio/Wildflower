import type { Style } from '@wildflowerhealthio/assistant-core-js'
import { FieldDescription, FieldGroup, SegmentedToggle } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

/** Props for {@link StyleChoice}. */
interface StyleChoiceProps {
  readonly style: Style.Type
  /** The chat has a message, so its style is fixed. */
  readonly locked: boolean
  /** Called with the style picked; the caller confirms academic before using it. */
  readonly onStyleRequest: (style: Style.Type) => void
}

/**
 * The chat's style as a two-way toggle, Telehealth · Academic, open until
 * the chat's first message and disabled after it.
 */
const StyleChoice = ({ style, locked, onStyleRequest }: StyleChoiceProps): JSX.Element => (
  <FieldGroup label="Style">
    <SegmentedToggle
      aria-label="Style"
      value={style}
      options={[
        { value: 'telehealth', label: 'Telehealth', disabled: locked },
        { value: 'academic', label: 'Academic', disabled: locked },
      ]}
      onChange={onStyleRequest}
    />
    {locked ? <FieldDescription>The style is fixed once a chat starts.</FieldDescription> : null}
  </FieldGroup>
)

export { StyleChoice }
export type { StyleChoiceProps }
