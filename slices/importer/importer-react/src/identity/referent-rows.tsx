import { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import {
  LinkableLogicalReference,
  LinkableResource,
  LinkChoice,
  LinkTarget,
  Referent,
  type ReferentLinkChoices,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array, HashMap, Option, pipe } from 'effect'
import { type JSX, memo, useId, useMemo } from 'react'

import {
  BIRTH_DATE,
  differingDemographicsWarning,
  DONT_LINK_LABEL,
  FAMILY_NAME,
  GIVEN_NAME,
  GROUP_HEADINGS,
  IN_IMPORT_GROUP,
  NEW_LABEL,
  newAsLabel,
  ON_SERVER_GROUP,
  REFERENTS_HEADING,
  referentTallyLine,
  type ReferentTally,
  sameAsLabel,
  STORED_LIST_ERROR_MESSAGE,
} from './referent-text.ts'
import { type StoredResource, useStoredResources } from './use-stored-resources.ts'
import styles from './referent-rows.module.css'

/**
 * The block above the format groups: one line per referent of the batch, its
 * label and a select of the `LinkChoice`s its kind allows, grouped by the
 * resource type its logical reference names, and a tally of where they land.
 *
 * @remarks
 * A referent with a resource offers `New` (its own resource becomes the
 * record) or a stored resource. One named only by mentions offers a stored
 * resource, the new record each other referent of its type creates (a
 * `LinkToDecodedReferent`), `New` when its logical reference stands for a
 * provisional record, and `Don't link`. The stored resources offered are the
 * default search's hits and the server's own, read up front. The groups are
 * the resource types the identity map links, in
 * `LinkableLogicalReference.RESOURCE_TYPES` order, and the one type-specific
 * rule, which demographics a link is checked against, is an exhaustive table
 * over them: a referent linked to a stored resource whose demographics differ
 * gets a warning line, and the link stands.
 *
 * @packageDocumentation
 */

/** Props for {@link ReferentRows}. */
interface ReferentRowsProps {
  /** The batch's referents, once per identity. */
  readonly referents: readonly Referent.Type[]
  /** The choices the batch is placed on, by `Referent.key`. */
  readonly linkChoices: ReferentLinkChoices.Type
  /** Each referent's link target under `linkChoices`, by `Referent.key`. */
  readonly linkTargets: HashMap.HashMap<string, LinkTarget.Type>
  /** The stored resources the default search found. */
  readonly found: readonly StoredResource[]
  /** Called with the reviewer's new choice for a referent. */
  readonly onChoose: (referentKey: string, choice: LinkChoice.Type) => void
}

/** One option of a referent's select: the choice it stands for and its label. */
interface ChoiceOption {
  readonly value: string
  readonly label: string
  readonly choice: LinkChoice.Type
}

/** A referent's options: those before the groups, the two groups, and those after. */
interface ChoiceOptions {
  readonly leading: readonly ChoiceOption[]
  readonly onServer: readonly ChoiceOption[]
  readonly inImport: readonly ChoiceOption[]
  readonly trailing: readonly ChoiceOption[]
}

/** Every option of `options`, in the order the select lists them. */
const allOptions = (options: ChoiceOptions): readonly ChoiceOption[] => [
  ...options.leading,
  ...options.onServer,
  ...options.inImport,
  ...options.trailing,
]

/** A choice as an option value, unique among one select's options. */
const valueOf = (choice: LinkChoice.Type): string =>
  LinkChoice.match(choice, {
    CreateResource: () => 'create',
    DontLink: () => 'dont-link',
    LinkToStoredResource: ({ resource }) =>
      `stored:${LinkableResource.literalReferenceOf(resource)}`,
    LinkToDecodedReferent: ({ referentKey }) => `decoded:${referentKey}`,
  })

const optionOf = (choice: LinkChoice.Type, label: string): ChoiceOption => ({
  value: valueOf(choice),
  label,
  choice,
})

const storedOption = ({ resource, label }: StoredResource): ChoiceOption =>
  optionOf(LinkChoice.LinkToStoredResource({ resource }), label)

const sameValue = (left: ChoiceOption, right: ChoiceOption): boolean => left.value === right.value

/** Whether `referent` creates a record of its own: its choice is `CreateResource`, and that lands on a resource. */
const createsRecord = (
  referent: Referent.Type,
  linkChoices: ReferentLinkChoices.Type,
  linkTargets: HashMap.HashMap<string, LinkTarget.Type>
): boolean =>
  LinkChoice.is('CreateResource')(LinkChoice.forReferent(linkChoices, referent)) &&
  HashMap.get(linkTargets, Referent.key(referent)).pipe(
    Option.exists((linkTarget) => !LinkTarget.is('Unlinked')(linkTarget))
  )

/** Everything the options of one referent are read from. */
type OptionInputs = Pick<ReferentRowsProps, 'referents' | 'linkChoices' | 'linkTargets'> & {
  /** The options for the stored resources of the referent's type: the search's hits, then the server's own. */
  readonly onServer: readonly ChoiceOption[]
}

/**
 * The options `referent`'s select offers under `current`, its choice: those
 * its kind allows, with the stored resource or the referent `current` names
 * among them.
 */
const optionsFor = (
  referent: Referent.Type,
  current: LinkChoice.Type,
  inputs: OptionInputs
): ChoiceOptions => {
  // A stored resource the choice names but the lists do not is offered by its literal reference.
  const currentOption = Option.liftPredicate(current, LinkChoice.is('LinkToStoredResource')).pipe(
    Option.map(({ resource }) =>
      storedOption({ resource, label: LinkableResource.literalReferenceOf(resource) })
    ),
    Option.filter((option) => !inputs.onServer.some((listed) => sameValue(listed, option)))
  )
  const onServer = Option.match(currentOption, {
    onNone: () => inputs.onServer,
    onSome: (option) => [...inputs.onServer, option],
  })
  return Referent.match(referent, {
    AsResource: () => ({
      leading: [optionOf(LinkChoice.CreateResource(), NEW_LABEL)],
      onServer,
      inImport: [],
      trailing: [],
    }),
    ByMentionOnly: ({ logicalReference }) => {
      const others = inputs.referents.filter(
        (other) =>
          other.logicalReference.type === logicalReference.type &&
          Referent.key(other) !== Referent.key(referent)
      )
      const linkedCurrently = LinkChoice.is('LinkToDecodedReferent')(current)
        ? others.filter((other) => Referent.key(other) === current.referentKey)
        : []
      const inImport = Array.dedupeWith(
        [
          ...others
            .filter((other) => createsRecord(other, inputs.linkChoices, inputs.linkTargets))
            .map((other) =>
              optionOf(
                LinkChoice.LinkToDecodedReferent({ referentKey: Referent.key(other) }),
                newAsLabel(other.label)
              )
            ),
          ...linkedCurrently.map((other) =>
            optionOf(
              LinkChoice.LinkToDecodedReferent({ referentKey: Referent.key(other) }),
              sameAsLabel(other.label)
            )
          ),
        ],
        sameValue
      )
      const provisional = Option.isSome(LinkableResource.tryProvisionalFrom(logicalReference))
        ? [optionOf(LinkChoice.CreateResource(), NEW_LABEL)]
        : []
      return {
        leading: [],
        onServer,
        inImport,
        trailing: [...provisional, optionOf(LinkChoice.DontLink(), DONT_LINK_LABEL)],
      }
    },
  })
}

/** One demographic a review compares two records of a person by, and how the warning names it. */
interface ComparedDemographic {
  readonly name: string
  readonly read: (demographics: Patient.Demographics) => Option.Option<string>
}

const COMPARED_PATIENT_DEMOGRAPHICS: readonly ComparedDemographic[] = [
  { name: FAMILY_NAME, read: ({ family }) => family },
  { name: GIVEN_NAME, read: ({ given }) => given },
  { name: BIRTH_DATE, read: ({ birthDate }) => birthDate },
]

/** Whether both `decoded` and `stored` state a value and the two differ. */
const bothStateAndDiffer = (
  decoded: Option.Option<string>,
  stored: Option.Option<string>
): boolean =>
  Option.all([decoded, stored]).pipe(
    Option.exists(([decodedValue, storedValue]) => decodedValue !== storedValue)
  )

/**
 * The demographics two Patients both state that differ, named as the warning
 * reads them, compared on `Patient.demographics` so the review and the
 * identifier the demographics derive agree on what a name is.
 */
const differingPatientDemographics = (
  decoded: Patient.Type,
  stored: Patient.Type
): readonly string[] => {
  const decodedDemographics = Patient.demographics(decoded)
  const storedDemographics = Patient.demographics(stored)
  return Array.filterMap(COMPARED_PATIENT_DEMOGRAPHICS, ({ name, read }) =>
    bothStateAndDiffer(read(decodedDemographics), read(storedDemographics))
      ? Option.some(name)
      : Option.none()
  )
}

/**
 * The demographics a link from `decoded` to `stored` is checked against that
 * differ: name and birth date for a Patient; a Practitioner has none the
 * review compares, since its name is the identity.
 */
const differingDemographics = (
  decoded: LinkableResource.WithId,
  stored: LinkableResource.WithId
): readonly string[] =>
  decoded.resourceType === 'Patient' && stored.resourceType === 'Patient'
    ? differingPatientDemographics(decoded, stored)
    : []

/**
 * The warning for a referent with a resource linked to a stored resource whose
 * demographics differ, or `None`.
 */
const differingDemographicsWarningFor = (
  referent: Referent.Type,
  choice: LinkChoice.Type
): Option.Option<string> =>
  Option.all({
    decoded: Option.liftPredicate(referent, Referent.is('AsResource')),
    stored: Option.liftPredicate(choice, LinkChoice.is('LinkToStoredResource')),
  }).pipe(
    Option.map(({ decoded, stored }) => differingDemographics(decoded.resource, stored.resource)),
    Option.filter(Array.isNonEmptyReadonlyArray),
    Option.map(differingDemographicsWarning)
  )

/**
 * How many records the referents land on: stored ones, and new or provisional
 * ones, each counted once however many referents share it; and how many
 * referents land nowhere.
 */
const tallyOf = (linkTargets: Iterable<LinkTarget.Type>): ReferentTally => {
  const targets = Array.fromIterable(linkTargets)
  const recordsAmong = (isCounted: (target: LinkTarget.Type) => boolean): number =>
    pipe(
      targets,
      Array.filter(isCounted),
      Array.filterMap(LinkTarget.tryIntoResource),
      Array.dedupeWith(
        (left, right) =>
          LinkableResource.literalReferenceOf(left) === LinkableResource.literalReferenceOf(right)
      ),
      Array.length
    )
  return {
    onServer: recordsAmong(LinkTarget.is('Stored')),
    created: recordsAmong(
      (target) => LinkTarget.is('Decoded')(target) || LinkTarget.is('Provisional')(target)
    ),
    unlinked: Array.countBy(targets, LinkTarget.is('Unlinked')),
  }
}

/** One option of a referent's select. */
const SelectOption = ({ option }: { readonly option: ChoiceOption }): JSX.Element => (
  <option value={option.value}>{option.label}</option>
)

/** One referent's line: its label, its select, and the warning when there is one. */
const ReferentRow = memo(function ReferentRow({
  referent,
  options,
  choice,
  onChoose,
}: {
  readonly referent: Referent.Type
  readonly options: ChoiceOptions
  readonly choice: LinkChoice.Type
  readonly onChoose: (referentKey: string, choice: LinkChoice.Type) => void
}): JSX.Element {
  const selectId = useId()
  const handleChange = (value: string): void =>
    Array.findFirst(allOptions(options), (option) => option.value === value).pipe(
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
        value={valueOf(choice)}
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
      {differingDemographicsWarningFor(referent, choice).pipe(
        Option.map((warning) => (
          <p key="warning" className={styles['referent-rows__warning']}>
            {warning}
          </p>
        )),
        Option.getOrNull
      )}
    </li>
  )
})

/** One referent with the choice it shows and the options its select offers. */
interface ReferentLine {
  readonly referent: Referent.Type
  readonly choice: LinkChoice.Type
  readonly options: ChoiceOptions
}

/** One resource type's referents under their heading, or nothing when it has none. */
const ReferentGroup = ({
  resourceType,
  props,
}: {
  readonly resourceType: LinkableLogicalReference.ResourceType
  readonly props: ReferentRowsProps
}): JSX.Element | null => {
  const { referents, linkChoices, linkTargets, found, onChoose } = props
  const ofType = useMemo(
    () => referents.filter((referent) => referent.logicalReference.type === resourceType),
    [referents, resourceType]
  )
  const stored = useStoredResources(resourceType, ofType.length > 0)
  // The stored options are built once per list, and shared by every line.
  const onServer = useMemo(
    (): readonly ChoiceOption[] =>
      pipe(
        [
          ...found.filter(({ resource }) => resource.resourceType === resourceType),
          ...(stored._tag === 'ready' ? stored.resources : []),
        ],
        Array.map(storedOption),
        Array.dedupeWith(sameValue)
      ),
    [found, stored, resourceType]
  )
  // The lines are worked out once per change of the choices, not per render.
  const lines = useMemo(
    (): readonly ReferentLine[] =>
      ofType.map((referent) => {
        const choice = LinkChoice.forReferent(linkChoices, referent)
        return {
          referent,
          choice,
          options: optionsFor(referent, choice, { referents, linkChoices, linkTargets, onServer }),
        }
      }),
    [ofType, referents, linkChoices, linkTargets, onServer]
  )
  if (ofType.length === 0) return null
  const heading = GROUP_HEADINGS[resourceType]
  return (
    <section aria-label={heading} className={styles['referent-rows__group']}>
      <h4 className={styles['referent-rows__group-heading']}>{heading}</h4>
      {stored._tag === 'error' && (
        <p role="alert" className={styles['referent-rows__warning']}>
          {STORED_LIST_ERROR_MESSAGE}
        </p>
      )}
      <ul className={styles['referent-rows__list']}>
        {lines.map(({ referent, choice, options }) => (
          <ReferentRow
            key={Referent.key(referent)}
            referent={referent}
            options={options}
            choice={choice}
            onChoose={onChoose}
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
        {referentTallyLine(tallyOf(HashMap.values(props.linkTargets)))}
      </p>
      {LinkableLogicalReference.RESOURCE_TYPES.map((resourceType) => (
        <ReferentGroup key={resourceType} resourceType={resourceType} props={props} />
      ))}
    </section>
  )
}

export { ReferentRows, type ReferentRowsProps }
