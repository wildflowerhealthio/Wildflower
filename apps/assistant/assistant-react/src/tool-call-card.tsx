import type {
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { ToolCall } from '@wildflowerhealthio/assistant-core-js'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import type { Option } from 'effect'
import type { ComponentProps, JSX } from 'react'

import styles from './tool-call-card.module.css'

/** Props for {@link ToolCallCard}: the call, its result if it has one, and any other `<details>` prop. */
interface ToolCallCardProps extends Omit<ComponentProps<'details'>, 'children'> {
  readonly call: BetaToolUseBlockParam
  /** The call's result; `None` when the turn stopped before it came back. */
  readonly result: Option.Option<BetaToolResultBlockParam>
}

/**
 * One tool call in a reply: a line saying what Claude looked up, such as
 * "Searched Observation: code=4548-4, up to 20", or what it wrote and how
 * that came out ("Create Observation: Created Observation/123"), which opens
 * to the parameters it gave and how many records came back. It never shows
 * the records themselves.
 */
const ToolCallCard = ({
  call,
  result,
  className,
  ...rootProps
}: ToolCallCardProps): JSX.Element => {
  const parameters = ToolCall.parametersOf(call)
  return (
    <details {...rootProps} className={cn(styles['tool-call-card'], className)}>
      <summary className={cn('text-label-3', styles['tool-call-card__summary'])}>
        {ToolCall.lineOf(call, result)}
      </summary>
      <div className={cn('text-body-3', styles['tool-call-card__body'])}>
        {parameters.length === 0 ? null : (
          <dl className={styles['tool-call-card__parameters']}>
            {parameters.map(({ name, value }, index) => (
              <div key={`${name}-${String(index)}`} className={styles['tool-call-card__parameter']}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className={styles['tool-call-card__result']}>
          {ToolCall.resultSummaryOf(call.name, result)}
        </p>
      </div>
    </details>
  )
}

export { ToolCallCard }
export type { ToolCallCardProps }
