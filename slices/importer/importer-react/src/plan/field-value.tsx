import { Option } from 'effect'
import type { JSX } from 'react'

import type * as FieldValueText from './field-value-text.ts'
import { NOT_RECORDED } from './plan-text.ts'

/**
 * A field's value as shown (`FieldValueText.FieldText`), the whole of it in
 * a tooltip when it is cut short; "Not recorded" when there is none.
 */
const FieldValue = ({
  text,
}: {
  readonly text: Option.Option<FieldValueText.FieldText>
}): JSX.Element =>
  text.pipe(
    Option.map((shown) => (
      <span key="value" title={Option.getOrUndefined(shown.whole)}>
        {shown.text}
      </span>
    )),
    Option.getOrElse(() => <>{NOT_RECORDED}</>)
  )

export { FieldValue }
