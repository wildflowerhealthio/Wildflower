/**
 * One referent's line in the referent block: its label, the select of the
 * link choices it offers, and the warning under it when there is one.
 *
 * @packageDocumentation
 */

import { type LinkChoice, Referent } from '@wildflowerhealthio/importer-fundamentals'
import { Array, Option } from 'effect'
import { type JSX, memo, useId } from 'react'

import * as LinkChoiceOptions from './link-choice-options.ts'
import { IN_IMPORT_GROUP, ON_SERVER_GROUP } from './referent-text.ts'
import styles from './referent-rows.module.css'

/** One option of a referent's select. */
const SelectOption = ({ option }: { readonly option: LinkChoiceOptions.Option }): JSX.Element => (
  <option value={option.value}>{option.label}</option>
)

/** One referent's line: its label, its select, and the warning when there is one. */
const ReferentRow = memo(function ReferentRow({
  referent,
  options,
  choice,
  warning,
  disabled,
  onChoose,
}: {
  readonly referent: Referent.Type
  readonly options: LinkChoiceOptions.Type
  readonly choice: LinkChoice.Type
  readonly warning: Option.Option<string>
  readonly disabled: boolean
  readonly onChoose: (referentKey: string, choice: LinkChoice.Type) => void
}): JSX.Element {
  const selectId = useId()
  const handleChange = (value: string): void =>
    Array.findFirst(LinkChoiceOptions.all(options), (option) => option.value === value).pipe(
      Option.map((option) => onChoose(Referent.key(referent), option.choice)),
      Option.getOrUndefined
    )
  return (
    <li className={styles['referent-rows__row']}>
      <label htmlFor={selectId} className={styles['referent-rows__label']}>
        {referent.label}
      </label>
      <select
        id={selectId}
        className={styles['referent-rows__select']}
        value={LinkChoiceOptions.valueOf(choice)}
        disabled={disabled}
        onChange={(event) => handleChange(event.target.value)}
      >
        {options.leading.map((option) => (
          <SelectOption key={option.value} option={option} />
        ))}
        {options.onServer.length > 0 && (
          <optgroup label={ON_SERVER_GROUP}>
            {options.onServer.map((option) => (
              <SelectOption key={option.value} option={option} />
            ))}
          </optgroup>
        )}
        {options.inImport.length > 0 && (
          <optgroup label={IN_IMPORT_GROUP}>
            {options.inImport.map((option) => (
              <SelectOption key={option.value} option={option} />
            ))}
          </optgroup>
        )}
        {options.trailing.map((option) => (
          <SelectOption key={option.value} option={option} />
        ))}
      </select>
      {warning.pipe(
        Option.map((text) => (
          <p key="warning" className={styles['referent-rows__warning']}>
            {text}
          </p>
        )),
        Option.getOrNull
      )}
    </li>
  )
})

export { ReferentRow }
