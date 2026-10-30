import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import type { ComponentProps, JSX, MouseEvent, ReactNode } from 'react'

import styles from './radio-card.module.css'

/** Controls inside a card that answer a click themselves. */
const OWN_CLICK_TARGETS = 'a, button, input, label, select, summary, textarea'

/**
 * Props for {@link RadioCard}: its radio, the evidence it shows, and any other
 * `<div>` prop (`id`, `data-*`, `ref`, a `className` added to its own), which
 * go to the card. Its `onClick` is the card's own, so a caller cannot set it.
 */
interface RadioCardProps extends Omit<ComponentProps<'div'>, 'children' | 'onClick' | 'onSelect'> {
  /** The radio group's name, shared by every card and line in the group. */
  readonly name: string
  readonly value: string
  readonly checked: boolean
  /** Called when the reader picks this card, by its radio or anywhere on the card. */
  readonly onSelect: () => void
  /** The radio's label: the action picking this card takes ("Use this existing record"). */
  readonly label: ReactNode
  /** The evidence for the choice, between the label and the card's foot. */
  readonly children: ReactNode
  /**
   * A line pinned above the tray, saying what picking this card does. Pinned
   * with the tray, so the lines in a row of cards line up.
   */
  readonly outcome?: ReactNode
  /**
   * Content docked to the card's foot, edge to edge: dashed above while the
   * card is not picked, a solid accent rule once it is.
   */
  readonly tray?: ReactNode
  /** `success` tints the picked card's tray, while picking it adds something. */
  readonly trayTone?: 'neutral' | 'success'
  /**
   * `raised` (default) is a solid edge on the raised surface, for something
   * that exists; `dashed` is a dashed edge with no fill, for something that
   * would only exist once picked.
   */
  readonly variant?: 'raised' | 'dashed'
}

/**
 * One option in a {@link RadioCardGroup}: a native radio whose label is the
 * action, over the evidence for it, with an optional tray docked at the foot.
 * The picked card wears the accent edge and fill. A click anywhere on the card
 * that no control inside answers picks it, and the radio keeps the native
 * group's arrow keys.
 */
const RadioCard = ({
  name,
  value,
  checked,
  onSelect,
  label,
  children,
  outcome,
  tray,
  trayTone = 'neutral',
  variant = 'raised',
  className,
  ...rootProps
}: RadioCardProps): JSX.Element => {
  const handleCardClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (checked || !(event.target instanceof Element)) return
    const control = event.target.closest(OWN_CLICK_TARGETS)
    if (control !== null && event.currentTarget.contains(control)) return
    onSelect()
  }
  return (
    <div
      {...rootProps}
      className={cn(
        styles['radio-card'],
        styles[`radio-card--${variant}`],
        checked ? styles['radio-card--checked'] : null,
        className
      )}
      onClick={handleCardClick}
    >
      <label className={styles['radio-card__label']}>
        <input
          type="radio"
          className="radio-3"
          name={name}
          value={value}
          checked={checked}
          onChange={onSelect}
        />
        <span>{label}</span>
      </label>
      <div className={styles['radio-card__body']}>{children}</div>
      {outcome === undefined ? null : (
        <div className={styles['radio-card__outcome']}>{outcome}</div>
      )}
      {tray === undefined ? null : (
        <div
          className={cn(
            styles['radio-card__tray'],
            trayTone === 'success' ? styles['radio-card__tray--success'] : null
          )}
        >
          {tray}
        </div>
      )}
    </div>
  )
}

/**
 * Props for {@link RadioCardGroup}: its cards, its accessible name, and any
 * other `<div>` prop, which go to the group. Its `role` is its own.
 */
interface RadioCardGroupProps extends Omit<ComponentProps<'div'>, 'role' | 'aria-label'> {
  /** Accessible name announced for the group. */
  readonly 'aria-label': string
  /** The {@link RadioCard}s, then any full-width lines (a plain radio row for "neither"). */
  readonly children: ReactNode
}

/**
 * A `radiogroup` laying its {@link RadioCard}s out as equal-height columns,
 * each at least 200px, wrapping as the width runs out. Any child that is not a
 * card (a plain radio row in the same group) spans the full width below them.
 */
const RadioCardGroup = ({
  'aria-label': ariaLabel,
  children,
  className,
  ...rootProps
}: RadioCardGroupProps): JSX.Element => (
  <div
    {...rootProps}
    className={cn(styles['radio-card__group'], className)}
    role="radiogroup"
    aria-label={ariaLabel}
  >
    {children}
  </div>
)

export { RadioCard, RadioCardGroup, type RadioCardGroupProps, type RadioCardProps }
