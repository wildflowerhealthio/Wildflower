import { useEffect, useId, useRef, useState, type JSX } from 'react'

import styles from './add-rule-button.module.css'

/** One addable resource — its scope name and the human label the list row shows. */
interface AddRuleOption {
  readonly name: string
  readonly label: string
}

interface AddRuleButtonProps {
  /** The resources offerable in this section (catalog entries not already shown). */
  readonly options: readonly AddRuleOption[]
  /** Add the chosen resource as a new (empty) row in the section. */
  readonly onAdd: (name: string) => void
}

/**
 * The "+ Add rule" affordance for one grid section (open / expandable mode) — a labelled
 * button that opens a floating list of the resources this section can still add (the catalog
 * minus the rows already shown, clamped to what the envelope can grant). Picking one hands the
 * resource name back so the picker surfaces an empty row for it; the first cell toggle then
 * creates the real scope. Modelled on {@link PatientPillPicker}'s dismiss-on-outside-click
 * listbox. Renders nothing when there is nothing left to add.
 */
const AddRuleButton = ({ options, onAdd }: AddRuleButtonProps): JSX.Element | null => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const node = rootRef.current
      const target = event.target
      if (node !== null && target instanceof Node && !node.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return (): void => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  if (options.length === 0) return null

  const add = (name: string): void => {
    onAdd(name)
    setOpen(false)
  }

  return (
    <div
      ref={rootRef}
      className={styles['add-rule']}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
    >
      <button
        type="button"
        className={styles['trigger']}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          setOpen((previous) => !previous)
        }}
      >
        + Add rule
      </button>
      {open ? (
        <div id={listId} className={styles['pop']} role="listbox" aria-label="Add a resource">
          {options.map((option) => (
            <button
              key={option.name}
              type="button"
              role="option"
              aria-selected={false}
              className={styles['option']}
              onClick={() => {
                add(option.name)
              }}
            >
              {option.label}
              <code className={styles['option-code']}>{option.name}</code>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export { AddRuleButton, type AddRuleButtonProps, type AddRuleOption }
