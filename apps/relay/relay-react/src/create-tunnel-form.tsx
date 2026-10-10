import { ErrorBanner, TextField } from '@wildflowerhealthio/react-tundraish'
import { Option } from 'effect'
import { useState, type SubmitEvent, type JSX } from 'react'

import { CreatedTunnelToken } from './created-tunnel-token.tsx'
import { useCreateTunnelMutation } from './queries/index.ts'
import styles from './create-tunnel-form.module.css'

/**
 * Create a tunnel for an email, under a chosen name or one the relay picks.
 * The new tunnel's token replaces the form until the operator is done with it.
 */
const CreateTunnelForm = (): JSX.Element => {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const create = useCreateTunnelMutation()
  const onSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const chosenName = name.trim()
    create.mutate(
      { email: email.trim(), ...(chosenName === '' ? {} : { name: chosenName }) },
      {
        onSuccess: () => {
          setEmail('')
          setName('')
        },
      }
    )
  }
  return Option.fromNullable(create.data).pipe(
    Option.map((created) => (
      <CreatedTunnelToken
        key="created"
        created={created}
        onDone={() => {
          create.reset()
        }}
      />
    )),
    Option.getOrElse(() => (
      <form className={styles['create-tunnel-form']} onSubmit={onSubmit}>
        <h2 className="text-heading-4">New tunnel</h2>
        <div className={styles['create-tunnel-form__fields']}>
          <TextField label="Owner’s email" type="email" value={email} onChange={setEmail} />
          <TextField
            label="Name (optional)"
            value={name}
            onChange={setName}
            description="A lowercase DNS label. Left empty, the relay picks one."
          />
        </div>
        <ErrorBanner error={create.error} />
        <div className={styles['create-tunnel-form__actions']}>
          <button
            type="submit"
            className="button-2 filled"
            disabled={create.isPending || email.trim() === ''}
          >
            Create tunnel
          </button>
        </div>
      </form>
    ))
  )
}

export { CreateTunnelForm }
