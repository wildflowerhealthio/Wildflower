import { Either } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import { type JSX, useState } from 'react'
import { Dialog, ErrorBanner } from 'react-tundraish'

import { prettyPrintResource, tryKeep } from './resource-editor-helpers.ts'
import styles from './resource-editor.module.css'

/**
 * The reviewer's inline JSON editor for one previewed FHIR resource — the
 * "manually edit them a little" affordance a `ReviewBody` row opens on
 * demand. A plain `<textarea>` over the pretty-printed JSON, kept behind
 * two invariants: an edit is refused unless it parses as JSON and decodes
 * through `Schema.decodeUnknown(FhirResource)`, and `resourceType` / `id`
 * are read-only (changing an id would break every reference and the
 * provenance link the confirm stamps).
 *
 * @packageDocumentation
 */

/** One kept edit that decoded and preserved `resourceType` / `id`. */
interface KeptEdit {
  /** The decoded resource the reviewer chose to keep — the value the review overrides with. */
  readonly resource: FhirResource
}

/** Props for {@link ResourceEditor}. */
interface ResourceEditorProps {
  /** Whether the dialog is open. */
  readonly open: boolean
  /** The resource currently being edited (the parsed original or a prior edit). */
  readonly resource: unknown
  /** Called with the kept edit once the reviewer accepts a decoded value. */
  readonly onEdit: (edit: KeptEdit) => void
  /** Called when the reviewer dismisses without keeping — no edit is applied. */
  readonly onCancel: () => void
}

/**
 * The dialog body — the textarea + error banner + actions. Mounted only
 * while the dialog is open so its internal state is seeded from the
 * `resource` prop **once, on mount**, without a "reseed on prop change"
 * effect. Re-opening the editor after a keep or revert mounts a fresh
 * instance and picks up the latest override.
 */
const EditorBody = ({
  resource,
  onEdit,
  onCancel,
}: {
  readonly resource: unknown
  readonly onEdit: (edit: KeptEdit) => void
  readonly onCancel: () => void
}): JSX.Element => {
  const [text, setText] = useState(() => prettyPrintResource(resource))
  const [error, setError] = useState<unknown>(null)

  const handleKeep = (): void => {
    const result = tryKeep(text, resource)
    if (Either.isLeft(result)) {
      setError(result.left)
      return
    }
    setError(null)
    onEdit({ resource: result.right })
  }

  return (
    <>
      <p className={styles.hint}>
        Edits are validated against the FHIR R4 schema. <code>resourceType</code> and{' '}
        <code>id</code> cannot be changed.
      </p>
      <textarea
        aria-label="Resource JSON"
        className={styles.textarea}
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        rows={20}
      />
      <ErrorBanner error={error} />
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={() => {
            setError(null)
            onCancel()
          }}
        >
          Cancel
        </button>
        <button type="button" className={styles.keepButton} onClick={handleKeep}>
          Keep
        </button>
      </div>
    </>
  )
}

/**
 * The inline JSON editor dialog for one previewed FHIR resource. The
 * Dialog wrapper stays mounted so tundraish can drive its close animation;
 * the {@link EditorBody} only mounts while the dialog is open, which is
 * what gives its textarea state a fresh seed each time.
 */
const ResourceEditor = ({ open, resource, onEdit, onCancel }: ResourceEditorProps): JSX.Element => (
  <Dialog open={open} onClose={onCancel} title="Edit resource">
    {open ? <EditorBody resource={resource} onEdit={onEdit} onCancel={onCancel} /> : null}
  </Dialog>
)

export { ResourceEditor }
export type { KeptEdit, ResourceEditorProps }
