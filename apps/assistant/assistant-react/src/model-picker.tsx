import type { ClaudeModel } from '@wildflowerhealthio/assistant-core-js'
import { Field } from '@wildflowerhealthio/react-tundraish'
import { type JSX, useId } from 'react'

/** Props for {@link ModelPicker}. */
interface ModelPickerProps {
  /** The models the key can use, newest first. */
  readonly models: readonly ClaudeModel.Type[]
  /** The model the next turn runs on. */
  readonly model: ClaudeModel.Type
  readonly onModelChange: (modelId: string) => void
}

/** A native picker of the key's models by name; the next turn runs on the one picked. */
const ModelPicker = ({ models, model, onModelChange }: ModelPickerProps): JSX.Element => {
  const selectId = useId()
  return (
    <Field label="Model" htmlFor={selectId}>
      <select
        id={selectId}
        className="input-3"
        value={model.id}
        onChange={(event) => {
          onModelChange(event.currentTarget.value)
        }}
      >
        {models.map(({ id, displayName }) => (
          <option key={id} value={id}>
            {displayName}
          </option>
        ))}
      </select>
    </Field>
  )
}

export { ModelPicker }
export type { ModelPickerProps }
