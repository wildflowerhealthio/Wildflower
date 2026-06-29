/**
 * The SMART v1 Read/Write *word components* — the two coarse parts a v1 client
 * can express, edited as a two-option multiselect (both ⇒ `*`). A view-model
 * affordance with no `scopes-rust` counterpart; it sits on top of
 * {@link AccessRights}.
 *
 * Namespace module (`import { Words } from 'scopes-core'`).
 */

import { AccessRights } from '../domain/index.ts'

/** The two selectable parts of a SMART v1 scope. Both ⇒ `*`; neither ⇒ no scope. */
export type Component = 'read' | 'write'

/** The components in display order. */
export const COMPONENTS: readonly Component[] = ['read', 'write']

/** User-facing label for each component (1:1 with the SMART v1 word). */
export const LABEL: Readonly<Record<Component, string>> = {
  read: 'Read',
  write: 'Write',
}

const COMPONENT_ACCESS: Readonly<Record<Component, AccessRights.AccessRights>> = {
  read: AccessRights.read,
  write: AccessRights.write,
}

/** Does `access` fully cover this component's CRUDS bits? (`null` ⇒ no.) */
export const covers = (access: AccessRights.AccessRights | null, component: Component): boolean => {
  if (access === null) return false
  const have = new Set(AccessRights.lettersOf(access))
  return AccessRights.lettersOf(COMPONENT_ACCESS[component]).every((a) => have.has(a))
}

/** Which components a given access currently selects (by CRUDS bits). */
export const of = (
  access: AccessRights.AccessRights | null
): Readonly<Record<Component, boolean>> => ({
  read: covers(access, 'read'),
  write: covers(access, 'write'),
})

/**
 * Build the v1 word {@link AccessRights.AccessRights} from a Read/Write selection: both ⇒
 * `star`, one ⇒ that word, neither ⇒ `null` (the scope is dropped).
 */
export const toAccess = (
  parts: Readonly<Record<Component, boolean>>
): AccessRights.AccessRights | null => {
  if (parts.read && parts.write) return AccessRights.star
  if (parts.read) return AccessRights.read
  if (parts.write) return AccessRights.write
  return null
}
