import { Scope } from '@wildflowerhealthio/scopes-core'

/**
 * A plain-language phrase for a scope — the verb(s) it grants and the
 * record type they act on, e.g. `wildflower/Apps.r` → "read Apps",
 * `wildflower/Grant.cd` → "create and delete Grants". Reuses the domain's own
 * fluency (the scope form's plain statements read the same `permission.label()`
 * words and `resource.pluralLabel()` names), so a surface that names scopes
 * (`AuthorizationFailure`, the authorization server's limited page) never shows
 * a raw `context/Resource.perms` string as its primary text.
 *
 * `null` when the string has no (verb, resource) shape — a bare known flag
 * (`openid`), the `wildflower/launch` umbrella, or an unparseable token — for
 * which the surface falls back to its own wording.
 */
const fluentScope = (raw: string): string | null => {
  const parsed = Scope.parse(raw)
  if (!Scope.ResourceScope.isResourceScope(parsed)) return null
  // `permission.label()` is the same sentence-joined verb list the scope form's
  // statements render ("Read", "Create and Delete"); lower-cased to sit mid-line
  // ("permission to …", "isn't allowed to …"). `pluralLabel()` matches the form's running-sentence
  // resource wording ("Apps", "Grants").
  return `${parsed.permission.label().toLowerCase()} ${parsed.resource.pluralLabel()}`
}

export { fluentScope }
