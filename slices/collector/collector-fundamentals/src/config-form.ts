import type { ReactNode } from 'react'

/**
 * The props a per-collector config form receives. `Config` is the concrete
 * config for one collector (e.g. the FHIR R4 `{ _tag, rootUrl, patientId }`),
 * so each form is written against its own precise shape. This contract lives
 * here — alongside the descriptor model each collector already depends on — so a
 * `*-client-collector` package can own its config form without depending on the
 * React account-screen adapter; `collector-react` assembles the forms into a
 * `tag → form` registry on top.
 *
 * The form owns its config fields and the submit boundary; the generic account
 * screens inject the shared chrome — the account-name field plus the type badge
 * (`header`, rendered above the fields) and the Save/Cancel row (`footer`,
 * rendered below, whose Save button is the form's `type="submit"`). A form
 * decodes on submit and calls {@link onSubmit} only with a valid `Config`.
 *
 * - `initial`: an existing remote's stored config, on the edit screen; the
 *   form seeds its fields from it. `undefined` on the create screen.
 * - `prefill`: a loose `Record<string, string>` handed off via the create
 *   screen's search params — a raw URL-search bag by design, *not* a decoded
 *   config (its values are plain strings, whereas a `Config`'s fields are
 *   branded schema types). A form reads the keys it recognises (falling back to
 *   its own defaults); callers are trusted to populate sensible keys.
 * - `disabled`: mirrors the owning mutation's pending state.
 * - `onSubmit`: called with the decoded config once the fields validate.
 */
interface ConfigFormProps<Config> {
  readonly initial: Config | undefined
  readonly prefill: Record<string, string> | undefined
  readonly disabled: boolean
  readonly onSubmit: (config: Config) => void
  readonly header: ReactNode
  readonly footer: ReactNode
}

export type { ConfigFormProps }
