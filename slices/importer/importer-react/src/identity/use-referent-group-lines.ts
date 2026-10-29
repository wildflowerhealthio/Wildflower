/**
 * The lines one resource type's group renders, kept across renders so a
 * select change rebuilds only the lines it changed, and the stored list the
 * group's select options come from.
 *
 * @packageDocumentation
 */

import {
  type LinkableLogicalReference,
  LinkableResource,
  Referent,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array, HashMap, Option } from 'effect'
import { useMemo, useState } from 'react'

import * as LinkChoiceOptions from './link-choice-options.ts'
import * as ReferentLine from './referent-line.ts'
import {
  type StoredResource,
  type StoredResourcesState,
  useStoredResourcesOfType,
} from './use-stored-resources-of-type.ts'

/** What a group renders: its lines, and the stored list it says is cut off or failed. */
interface ReferentGroupLines {
  /** One per referent of the group's type, in the batch's order. */
  readonly lines: readonly ReferentLine.Type[]
  /** The server's stored list of the group's type. */
  readonly stored: StoredResourcesState
}

/**
 * The lines of `resourceType`'s referents, each kept by identity while what
 * it was built from has not changed, which `ReferentRow`'s memo compares.
 *
 * @param resourceType - The group's resource type
 * @param props - The referent block's batch, choices, link targets and search hits
 * @returns The group's lines and its stored list
 */
const useReferentGroupLines = (
  resourceType: LinkableLogicalReference.ResourceType,
  props: Pick<LinkChoiceOptions.Inputs, 'referents' | 'linkChoices' | 'linkTargets'> & {
    /** The stored resources the default search found. */
    readonly found: readonly StoredResource[]
  }
): ReferentGroupLines => {
  const { referents, linkChoices, linkTargets, found } = props
  const ofType = useMemo(
    () => referents.filter((referent) => referent.logicalReference.type === resourceType),
    [referents, resourceType]
  )
  const stored = useStoredResourcesOfType(resourceType, ofType.length > 0)
  // The stored resources, and their options, are worked out once per list and shared by every line.
  const storedOfType = useMemo(
    (): readonly StoredResource[] =>
      Array.dedupeWith(
        [
          ...found.filter(({ resource }) => resource.resourceType === resourceType),
          ...(stored._tag === 'ready' ? stored.resources : []),
        ],
        (left, right) => LinkableResource.sameRecord(left.resource, right.resource)
      ),
    [found, stored, resourceType]
  )
  const onServer = useMemo(
    (): readonly LinkChoiceOptions.Option[] => storedOfType.map(LinkChoiceOptions.storedOption),
    [storedOfType]
  )
  const ownRecordWritersKey = useMemo(
    () =>
      referents
        .filter((referent) => LinkChoiceOptions.writesOwnRecord(referent, linkChoices, linkTargets))
        .map(Referent.key)
        .join('\n'),
    [referents, linkChoices, linkTargets]
  )
  // The built lines are kept in state and adjusted during render (the
  // "derive from a changed prop" pattern), so a line survives the changes it
  // does not depend on.
  const [builtLines, setBuiltLines] = useState<HashMap.HashMap<string, ReferentLine.Built>>(
    HashMap.empty()
  )
  const nextBuiltLines = useMemo(
    () =>
      ReferentLine.buildAll(
        ofType,
        { referents, linkChoices, linkTargets, storedOfType, onServer, ownRecordWritersKey },
        builtLines
      ),
    [
      ofType,
      referents,
      linkChoices,
      linkTargets,
      storedOfType,
      onServer,
      ownRecordWritersKey,
      builtLines,
    ]
  )
  if (nextBuiltLines !== builtLines) setBuiltLines(nextBuiltLines)
  const lines = Array.filterMap(ofType, (referent) =>
    Option.map(HashMap.get(nextBuiltLines, Referent.key(referent)), ({ line }) => line)
  )
  return { lines, stored }
}

export { useReferentGroupLines }
