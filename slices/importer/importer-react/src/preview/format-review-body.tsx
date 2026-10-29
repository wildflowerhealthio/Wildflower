import type { ServerComparison } from '@wildflowerhealthio/fhir-r4/clients'
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import {
  type FormatDecode,
  DecodedFile,
  LinkChoice,
  Mention,
  StagedImport,
  type UnlinkedMention,
} from '@wildflowerhealthio/importer-fundamentals'
import { Chip } from '@wildflowerhealthio/react-tundraish'
import { Array, Option } from 'effect'
import { type JSX, useMemo } from 'react'

import * as MentionLinkOptions from '../identity/mention-link-options.ts'
import { DONT_LINK_LABEL } from '../identity/referent-text.ts'
import { describeResource, type ResourceDescription, resourceTypeOf } from './describe-resource.ts'
import { DiffBadge } from './diff-badge.tsx'
import {
  mentionLead,
  mentionRole,
  NEEDS_A_PATIENT_HEADING,
  NEEDS_A_PROVIDER_HEADING,
  NO_RESOURCES_MESSAGE,
  plural,
  UNREADABLE_FILE_MESSAGE,
} from './preview-text.ts'
import { SectionToggle } from './section-toggle.tsx'
import { groupsOf, isAt, isOfPatient, reasonsLine, unlinkedIn } from './unlinked-mentions.ts'
import styles from './format-review-body.module.css'

/**
 * One format's review body — the generalized per-resource review every format
 * shares, the per-type tallies above it, and the resources it lists as
 * needing a patient or a provider.
 *
 * @remarks
 * A row whose resource makes a mention the identity map can link carries an
 * inline select per such mention, read as part of its summary line ("for
 * Tyra Banks", "requested by …"): the resources the batch's referents are
 * linked to, of the type the mention names (`MentionLinkOptions`), plus Don't link
 * where the mention keeps something to name or the referent choices leave
 * it unlinked. A pick is a mention link choice in the identity map
 * (`onChooseMention`), not an edit: the resolved resource redirects the
 * mention there and the row is not marked edited; a row with an edit
 * override has the override relinked at that mention too, since the
 * override is what gets written. The resources the referent choices leave a
 * mention unlinked in are listed again above the sections, under Needs a
 * patient (an unlinked `subject`) or else Needs a provider, each with why;
 * a pick keeps a row there, so it keeps focus. Picking a patient for a
 * resource listed under Needs a patient also includes it, since the screen
 * leaves those out until one is assigned, and picking Don't link leaves it
 * out again.
 *
 * @packageDocumentation
 */

/** Set the choice for the mention at `mentionPath` of the resource reviewed under `reviewKey`. */
type ChooseMention = (
  reviewKey: string,
  mentionPath: string,
  choice: LinkChoice.MentionLinkChoice
) => void

/** Nothing offered, so no pick is ever made: the body without an identity map. */
const chooseNothing: ChooseMention = () => undefined

/** Aggregate include/exclude totals across a file's resources, by resource type. */
interface TypeTally {
  readonly type: string
  readonly total: number
  readonly excluded: number
}

/** The per-type tallies of one format's decoded resources, in first-seen order. */
const perTypeTallies = (
  decodedFile: DecodedFile.DecodedFile,
  selection: StagedImport.Selection
): readonly TypeTally[] => {
  const order: string[] = []
  const totals = new Map<string, { total: number; excluded: number }>()
  for (const resource of DecodedFile.resources(decodedFile)) {
    const type = resourceTypeOf(resource.resource)
    const excluded = StagedImport.isResourceIncluded(selection, resource.key) ? 0 : 1
    const bucket = totals.get(type)
    if (bucket === undefined) {
      order.push(type)
      totals.set(type, { total: 1, excluded })
    } else {
      bucket.total += 1
      bucket.excluded += excluded
    }
  }
  return order.map((type) => {
    const bucket = totals.get(type) ?? { total: 0, excluded: 0 }
    return { type, total: bucket.total, excluded: bucket.excluded }
  })
}

/** The one-line tally label for one resource type ("14 MedicationRequest, 2 excluded"). */
const tallyLabel = (tally: TypeTally): string => {
  const base = `${tally.total} ${tally.type}`
  return tally.excluded === 0 ? base : `${base}, ${tally.excluded} excluded`
}

/** The value of a mention select's Don't link option. */
const DONT_LINK_VALUE = 'dont-link'

/** The value of the option for the literal reference the mention carries now, when no resolved resource's option has it. */
const currentValue = (literalReference: string): string => `current:${literalReference}`

/** The literal reference by which the mention at `mentionPath` of `resource` names a record of the device. */
const deviceLiteralOf = (
  resource: FhirResourceWithId,
  mentionPath: string
): Option.Option<string> =>
  Mention.at(resource, mentionPath).pipe(
    Option.filter(({ reference }) => Mention.isDeviceLiteral(reference)),
    Option.flatMapNullable(({ reference }) => reference.reference)
  )

/**
 * One mention's inline select: the lead ("for", "requested by"), then the
 * resolved resources offered for its type, the one it names now when none of them is
 * it, and Don't link when the mention can be left unlinked.
 */
const MentionSelect = ({
  mention,
  name,
  reviewed,
  options,
  unlinkedByReferents,
  onPick,
}: {
  readonly mention: Mention.Linkable
  readonly name: string
  /** The resource as reviewed: resolved, or its edit override. */
  readonly reviewed: FhirResourceWithId
  readonly options: readonly MentionLinkOptions.Option[]
  /** Whether the referent choices alone leave this mention unlinked. */
  readonly unlinkedByReferents: boolean
  /** Called with the option picked, or `None` for Don't link. */
  readonly onPick: (picked: Option.Option<MentionLinkOptions.Option>) => void
}): JSX.Element => {
  const deviceLiteral = deviceLiteralOf(reviewed, mention.path)
  const namedOption = Option.flatMap(deviceLiteral, (literalReference) =>
    Array.findFirst(options, (option) => option.literalReference === literalReference)
  )
  // A literal reference no option has keeps an option of its own, so the
  // select shows what the mention names; an absolute URL names no
  // resource of the device, as Don't link does.
  const current = Option.isSome(namedOption) ? Option.none() : deviceLiteral
  const value = Option.match(namedOption, {
    onNone: () => Option.match(current, { onNone: () => DONT_LINK_VALUE, onSome: currentValue }),
    onSome: (option) => option.value,
  })
  // Don't link where it leaves the mention something to name, or where the
  // referent choices alone leave it unlinked, so a pick can be taken back.
  const canUnlink =
    value === DONT_LINK_VALUE ||
    unlinkedByReferents ||
    Mention.relinked(reviewed, mention.path, Option.none()) !== reviewed
  const handleChange = (picked: string): void => {
    if (picked === DONT_LINK_VALUE) onPick(Option.none())
    const option = options.find((one) => one.value === picked)
    if (option !== undefined) onPick(Option.some(option))
  }
  return (
    <span className={styles['review-body__mention']}>
      {mentionLead(mention.path)}
      <select
        aria-label={name}
        className={styles['review-body__mention-select']}
        value={value}
        onChange={(event) => handleChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {current.pipe(
          Option.map((literalReference) => (
            <option key={currentValue(literalReference)} value={currentValue(literalReference)}>
              {mention.reference.display ?? literalReference}
            </option>
          )),
          Option.getOrNull
        )}
        {canUnlink && <option value={DONT_LINK_VALUE}>{DONT_LINK_LABEL}</option>}
      </select>
    </span>
  )
}

/** Each mention's accessible name: its role, numbered when the field holds several, and the row's description. */
const selectNames = (
  mentions: readonly Mention.Linkable[],
  description: ResourceDescription
): readonly string[] =>
  mentions.map((mention, index) => {
    const role = mentionRole(mention.path)
    const sameRole = mentions.filter((other) => mentionRole(other.path) === role)
    const number =
      sameRole.length > 1
        ? ` ${mentions.slice(0, index + 1).filter((other) => mentionRole(other.path) === role).length}`
        : ''
    return `${role}${number} of ${description.type} ${description.summary}`
  })

/**
 * One previewed resource's row: its type, one-line summary, the inline select
 * of each mention it makes that the map can link, include toggle, Edit/Revert
 * affordance, and the "edited" chip when a per-resource override is in
 * place. Listed under Needs a patient or Needs a provider, it also says why.
 */
const ResourceRow = ({
  resourceKey,
  resource,
  selection,
  comparison,
  mentionLinkOptions,
  unlinked,
  listsReason,
  onToggle,
  onEdit,
  onRevert,
  onKeepServerValue,
  onPick,
}: {
  readonly resourceKey: string
  readonly resource: FhirResourceWithId
  readonly selection: StagedImport.Selection
  readonly comparison: ServerComparison | undefined
  readonly mentionLinkOptions: MentionLinkOptions.Type
  /** The format's mentions the referent choices alone leave unlinked. */
  readonly unlinked: readonly UnlinkedMention.Type[]
  readonly listsReason: boolean
  readonly onToggle: (key: string) => void
  readonly onEdit: (key: string, resource: unknown) => void
  readonly onRevert: (key: string) => void
  readonly onKeepServerValue: (key: string, resource: FhirResourceWithId) => void
  readonly onPick: (
    mention: Mention.Linkable,
    picked: Option.Option<MentionLinkOptions.Option>
  ) => void
}): JSX.Element => {
  const edited = Option.getOrElse(
    StagedImport.editedResource(selection, resourceKey),
    () => resource
  )
  // Every selection change re-renders every row; the description encodes the
  // resource and the mentions walk it, so both wait for the resource to change.
  const description = useMemo(
    () => describeResource(edited, mentionLinkOptions.labelsByLiteralReference),
    [edited, mentionLinkOptions.labelsByLiteralReference]
  )
  // Without a resource of either type offered there is nothing to pick, and
  // no need to read the resource's mentions at all.
  const mentions = useMemo(
    () =>
      mentionLinkOptions.labelsByLiteralReference.size === 0
        ? []
        : Mention.linkableIn(edited).filter(
            (mention) => MentionLinkOptions.forType(mentionLinkOptions, mention.type).length > 0
          ),
    [edited, mentionLinkOptions]
  )
  const names = selectNames(mentions, description)
  const included = StagedImport.isResourceIncluded(selection, resourceKey)
  const isEdited = StagedImport.isResourceEdited(selection, resourceKey)
  const reason = listsReason ? reasonsLine(resourceKey, edited) : ''
  const hasSubjectSelect = mentions.some((mention) => mention.path === Mention.SUBJECT_PATH)
  return (
    <li className={styles['review-body__resource-row']}>
      <label className={styles['review-body__resource-label']}>
        <input
          type="checkbox"
          checked={included}
          aria-label={`Include ${description.type} ${description.summary}`}
          onChange={() => onToggle(resourceKey)}
        />
        <span
          className={
            included
              ? styles['review-body__resource-type']
              : styles['review-body__resource-excluded']
          }
        >
          {description.type}
        </span>
        <span
          className={
            included
              ? styles['review-body__resource-summary']
              : styles['review-body__resource-excluded']
          }
        >
          {description.summary}
        </span>
      </label>
      {reason !== '' && <span className={styles['review-body__unlinked-reason']}>{reason}</span>}
      {hasSubjectSelect
        ? null
        : description.subject.pipe(
            Option.map((subject) => (
              <span key="subject" className={styles['review-body__mention']}>
                {`${mentionLead(Mention.SUBJECT_PATH)} ${subject}`}
              </span>
            )),
            Option.getOrNull
          )}
      {mentions.map((mention, index) => (
        <MentionSelect
          key={mention.path}
          mention={mention}
          name={names[index] ?? ''}
          reviewed={edited}
          options={MentionLinkOptions.forType(mentionLinkOptions, mention.type)}
          unlinkedByReferents={unlinked.some((one) => isAt(one, resourceKey, mention.path))}
          onPick={(picked) => onPick(mention, picked)}
        />
      ))}
      <DiffBadge
        comparison={comparison}
        current={edited}
        onKeepServerValue={(next) => onKeepServerValue(resourceKey, next)}
      />
      {isEdited && <Chip className={styles['review-body__edited-chip']}>Edited</Chip>}
      <button
        type="button"
        className={styles['review-body__edit-button']}
        onClick={() => onEdit(resourceKey, edited)}
        aria-label={`Edit ${description.type} ${description.summary}`}
      >
        Edit
      </button>
      {isEdited && (
        <button
          type="button"
          className={styles['review-body__revert-button']}
          onClick={() => onRevert(resourceKey)}
          aria-label={`Revert edit to ${description.type} ${description.summary}`}
        >
          Revert
        </button>
      )}
    </li>
  )
}

/**
 * One format's decoded sections and notes — the generalized review body
 * every format shares: a per-type tally, the resources needing a patient or a
 * provider, one titled section per decode section with per-resource rows, and
 * the format's diagnostic notes folded into a collapsed details block.
 */
const FormatReviewBody = ({
  result,
  selection,
  comparisons,
  mentionLinkOptions = MentionLinkOptions.empty,
  unlinked,
  onSelectionChange,
  onEditResource,
  onChooseMention = chooseNothing,
}: {
  readonly result: FormatDecode.Result<string>
  readonly selection: StagedImport.Selection
  readonly comparisons: ReadonlyMap<string, ServerComparison> | undefined
  /** What each mention select offers; nothing without an identity map. */
  readonly mentionLinkOptions?: MentionLinkOptions.Type
  /** The mentions the referent choices alone leave unlinked in the file, source files aside. */
  readonly unlinked: readonly UnlinkedMention.Type[]
  readonly onSelectionChange: (selection: StagedImport.Selection) => void
  readonly onEditResource: (key: string, resource: unknown) => void
  /** The identity map's action a pick drives. */
  readonly onChooseMention?: ChooseMention
}): JSX.Element => {
  const { sections, notes } = result.decoded
  const tallies = useMemo(
    () => perTypeTallies(result.decoded, selection),
    [result.decoded, selection]
  )
  const groups = useMemo(() => groupsOf(result.decoded, unlinked), [result.decoded, unlinked])

  const needsPatient = (key: string): boolean =>
    groups.needingPatient.some((listed) => listed.key === key)

  // A pick is a mention link choice. A row's edit override is written in
  // place of the resolved resource, so it is relinked at that mention too.
  // On a resource listed under Needs a patient, a patient pick includes it
  // and Don't link leaves it out again, as the screen first did.
  const pick = (
    { key }: DecodedFile.Resource,
    mention: Mention.Linkable,
    picked: Option.Option<MentionLinkOptions.Option>
  ): void => {
    onChooseMention(
      key,
      mention.path,
      Option.match(picked, {
        onNone: (): LinkChoice.MentionLinkChoice => LinkChoice.DontLink(),
        onSome: ({ choice }) => choice,
      })
    )
    const relinked = Option.match(StagedImport.editedResource(selection, key), {
      onNone: () => selection,
      onSome: (edited) =>
        StagedImport.edit(
          selection,
          key,
          Mention.relinked(
            edited,
            mention.path,
            Option.map(picked, ({ literalReference }) => literalReference)
          )
        ),
    })
    const next =
      mention.path === Mention.SUBJECT_PATH && needsPatient(key)
        ? StagedImport.setResourcesIncluded(relinked, [key], Option.isSome(picked))
        : relinked
    if (next !== selection) onSelectionChange(next)
  }

  // Revert restores the resolved resource, so one listed under Needs a
  // patient that has no patient there either is left out again.
  const revert = ({ key, resource }: DecodedFile.Resource): void => {
    const reverted = StagedImport.revert(selection, key)
    const leftWithoutPatient = needsPatient(key) && unlinkedIn(key, resource).some(isOfPatient)
    onSelectionChange(
      leftWithoutPatient ? StagedImport.setResourcesIncluded(reverted, [key], false) : reverted
    )
  }

  const renderRow = (entry: DecodedFile.Resource, listsReason: boolean): JSX.Element => (
    <ResourceRow
      key={entry.key}
      resourceKey={entry.key}
      resource={entry.resource}
      selection={selection}
      comparison={comparisons?.get(entry.key)}
      mentionLinkOptions={mentionLinkOptions}
      unlinked={unlinked}
      listsReason={listsReason}
      onToggle={(key) => onSelectionChange(StagedImport.toggleResource(selection, key))}
      onEdit={onEditResource}
      onRevert={() => revert(entry)}
      onKeepServerValue={(key, next) => onSelectionChange(StagedImport.edit(selection, key, next))}
      onPick={(mention, picked) => pick(entry, mention, picked)}
    />
  )
  const unlinkedGroup = (
    heading: string,
    listed: readonly DecodedFile.Resource[]
  ): JSX.Element | null =>
    listed.length === 0 ? null : (
      <section aria-label={heading} className={styles['review-body__unlinked']}>
        <h4 className={styles['review-body__unlinked-heading']}>{heading}</h4>
        <ul className={styles['review-body__resource-list']}>
          {listed.map((entry) => renderRow(entry, true))}
        </ul>
      </section>
    )
  return (
    <div className={styles['review-body']}>
      {tallies.length > 0 && (
        <p role="status" className={styles['review-body__tally']}>
          {tallies.map(tallyLabel).join(' · ')}
        </p>
      )}
      {unlinkedGroup(NEEDS_A_PATIENT_HEADING, groups.needingPatient)}
      {unlinkedGroup(NEEDS_A_PROVIDER_HEADING, groups.needingProvider)}
      {sections.length === 0 && result.unreadableFiles.length === 0 && (
        <p className={styles['review-body__empty']}>{NO_RESOURCES_MESSAGE}</p>
      )}
      {result.unreadableFiles.length > 0 && (
        <ul className={styles['review-body__note-list']}>
          {result.unreadableFiles.map((file) => (
            <li key={file.id} className={styles['review-body__note']}>
              {file.title}: {UNREADABLE_FILE_MESSAGE}
            </li>
          ))}
        </ul>
      )}
      {sections.map((section) => (
        <section
          // A resource key is namespaced by the file it came from
          // (`FormatDecode.keyPrefix`), so it is unique across the format —
          // which lets a section's first resource identify it even when two
          // files contribute sections of the same title.
          key={section.resources[0]?.key ?? section.title}
          className={styles['review-body__section']}
          aria-label={section.title}
        >
          <SectionToggle
            title={section.title}
            keys={section.resources.map((resource) => resource.key)}
            isIncluded={(key) => StagedImport.isResourceIncluded(selection, key)}
            onSetIncluded={(keys, included) => {
              onSelectionChange(StagedImport.setResourcesIncluded(selection, keys, included))
            }}
          />
          <ul className={styles['review-body__resource-list']}>
            {section.resources.map((entry) => renderRow(entry, false))}
          </ul>
        </section>
      ))}
      {notes.length > 0 && (
        <details className={styles['review-body__notes']}>
          <summary className={styles['review-body__notes-summary']}>
            {`${notes.length} ${plural(notes.length, 'note')}`}
          </summary>
          <ul className={styles['review-body__note-list']}>
            {notes.map((note) => (
              <li key={note} className={styles['review-body__note']}>
                {note}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

export { type ChooseMention, FormatReviewBody }
