import {
  LinkableLogicalReference,
  type LinkChoice,
  type LinkTarget,
  Referent,
  type ReferentLinkChoiceSet,
  ReferentTally,
} from '@wildflowerhealthio/importer-fundamentals'
import { HashMap } from 'effect'
import type { JSX } from 'react'

import { ReferentRow } from './referent-row.tsx'
import {
  GROUP_HEADINGS,
  REFERENTS_HEADING,
  referentTallyLine,
  STORED_LIST_ERROR_MESSAGE,
  STORED_LIST_TRUNCATED_MESSAGE,
} from './referent-text.ts'
import { useReferentGroupLines } from './use-referent-group-lines.ts'
import type { StoredResource } from './use-stored-resources-of-type.ts'
import styles from './referent-rows.module.css'

/**
 * The block above the format groups: one line per referent of the batch, its
 * label and a select of the `LinkChoice`s its kind allows, grouped by the
 * resource type its logical reference names, and a tally of where they land.
 *
 * @remarks
 * The groups are the resource types the identity map links, in
 * `LinkableLogicalReference.RESOURCE_TYPES` order. A group says when its
 * stored list could not be read, or was cut off, above its lines.
 *
 * @packageDocumentation
 */

/** Props for {@link ReferentRows}. */
interface ReferentRowsProps {
  /** The batch's referents, once per identity. */
  readonly referents: readonly Referent.Type[]
  /** The choices the batch is resolved on, by `Referent.key`. */
  readonly linkChoices: ReferentLinkChoiceSet.Type
  /** Each referent's link target under `linkChoices`, by `Referent.key`. */
  readonly linkTargets: HashMap.HashMap<string, LinkTarget.Type>
  /** The stored resources the default search found. */
  readonly found: readonly StoredResource[]
  /** Whether the selects take no choice: while the batch is refused, a choice could not be resolved or shown. */
  readonly disabled: boolean
  /** Called with the reviewer's new choice for a referent. */
  readonly onChoose: (referentKey: string, choice: LinkChoice.Type) => void
}

/** One resource type's referents under their heading, or nothing when it has none. */
const ReferentGroup = ({
  resourceType,
  props,
}: {
  readonly resourceType: LinkableLogicalReference.ResourceType
  readonly props: ReferentRowsProps
}): JSX.Element | null => {
  const { lines, stored } = useReferentGroupLines(resourceType, props)
  if (lines.length === 0) return null
  const heading = GROUP_HEADINGS[resourceType]
  return (
    <section aria-label={heading} className={styles['referent-rows__group']}>
      <h4 className={styles['referent-rows__group-heading']}>{heading}</h4>
      {stored._tag === 'error' && (
        <p role="alert" className={styles['referent-rows__warning']}>
          {STORED_LIST_ERROR_MESSAGE}
        </p>
      )}
      {stored._tag === 'ready' && stored.truncated && (
        <p role="note" className={styles['referent-rows__warning']}>
          {STORED_LIST_TRUNCATED_MESSAGE}
        </p>
      )}
      <ul className={styles['referent-rows__list']}>
        {lines.map(({ referent, choice, options, warning }) => (
          <ReferentRow
            key={Referent.key(referent)}
            referent={referent}
            options={options}
            choice={choice}
            warning={warning}
            disabled={props.disabled}
            onChoose={props.onChoose}
          />
        ))}
      </ul>
    </section>
  )
}

/** The referent block, or nothing when the batch has no referent. */
const ReferentRows = (props: ReferentRowsProps): JSX.Element | null => {
  if (props.referents.length === 0) return null
  return (
    <section aria-label={REFERENTS_HEADING} className={styles['referent-rows']}>
      <h3 className={styles['referent-rows__heading']}>{REFERENTS_HEADING}</h3>
      <p role="status" className={styles['referent-rows__tally']}>
        {referentTallyLine(ReferentTally.of(HashMap.values(props.linkTargets)))}
      </p>
      {LinkableLogicalReference.RESOURCE_TYPES.map((resourceType) => (
        <ReferentGroup key={resourceType} resourceType={resourceType} props={props} />
      ))}
    </section>
  )
}

export { ReferentRows, type ReferentRowsProps }
