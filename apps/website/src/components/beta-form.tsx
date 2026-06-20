import { useState } from 'react'
import type { FormEvent, JSX } from 'react'

import styles from './beta-form.module.css'

/** Which page the form sits on — drives the copy and the leading success dot. */
type BetaFormVariant = 'hero' | 'cta'

const COPY: Record<BetaFormVariant, { button: string; success: string; dot: boolean }> = {
  hero: {
    button: 'Request beta invite',
    success: "You're on the list — we'll send your invite soon.",
    dot: true,
  },
  cta: {
    button: 'Request invite',
    success: 'Thanks — your invite is on its way.',
    dot: false,
  },
}

/**
 * The beta-invite email form, shown in the hero and again in the CTA. On a
 * valid submit it swaps itself for an inline success message (no backend in
 * the prototype). The two variants differ only in button styling and copy;
 * the hero success also carries a leading green dot.
 */
function BetaForm({ variant }: { readonly variant: BetaFormVariant }): JSX.Element {
  const [submitted, setSubmitted] = useState(false)
  const copy = COPY[variant]
  const inputId = `beta-email-${variant}`

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const form = event.currentTarget
    if (!form.checkValidity()) {
      form.reportValidity()
      return
    }
    // Prototype only — no signup service. To wire one up, read the email
    // (`new FormData(form).get('email')`), POST it, and move `setSubmitted`
    // into the success branch of the response (with loading + error states).
    setSubmitted(true)
  }

  if (submitted) {
    return (
      <div className={styles['beta-form__success']} role="status">
        {copy.dot ? <span className={styles['beta-form__success-dot']} /> : null}
        {copy.success}
      </div>
    )
  }

  return (
    <form className={styles['beta-form']} onSubmit={handleSubmit} noValidate>
      <div className={styles['beta-form__field']}>
        <label className="visually-hidden" htmlFor={inputId}>
          Email address
        </label>
        <input
          className={`input-3 ${styles['beta-form__input']}`}
          id={inputId}
          name="email"
          type="email"
          required
          placeholder="you@email.com"
          autoComplete="email"
        />
      </div>
      <button className={`button-3 filled ${styles['beta-form__submit']}`} type="submit">
        {copy.button}
      </button>
    </form>
  )
}

export { BetaForm }
