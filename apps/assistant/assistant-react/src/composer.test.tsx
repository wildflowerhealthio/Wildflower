import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { Composer } from './composer.tsx'

afterEach(cleanup)

/** A send the test settles by hand, and what was sent. */
const heldSend = (): {
  readonly onSend: (text: string) => Promise<void>
  readonly sent: string[]
  readonly resolve: () => void
  readonly reject: () => void
} => {
  const sent: string[] = []
  let settle = { resolve: (): void => undefined, reject: (): void => undefined }
  return {
    onSend: (text) => {
      sent.push(text)
      return new Promise<void>((resolve, reject) => {
        settle = { resolve, reject: () => reject(new Error('Not kept')) }
      })
    },
    sent,
    resolve: () => settle.resolve(),
    reject: () => settle.reject(),
  }
}

/** Render the composer, not replying, sending through `onSend`. */
const renderComposer = (onSend: (text: string) => Promise<void>): void => {
  render(
    <Composer
      replying={false}
      messageDisabled={false}
      onSend={onSend}
      onStop={() => undefined}
      onNewChat={() => undefined}
    />
  )
}

const messageBox = (): HTMLTextAreaElement => screen.getByLabelText<HTMLTextAreaElement>('Message')
const sendButton = (): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Send' })

describe('Composer', () => {
  it('should lock the message box and Send while sending, then clear the draft once sent', async () => {
    const user = userEvent.setup()
    const send = heldSend()
    renderComposer(send.onSend)

    await user.type(messageBox(), 'How are my labs?')
    await user.click(sendButton())

    expect(send.sent).toEqual(['How are my labs?'])
    expect(messageBox().disabled).toBe(true)
    expect(sendButton().disabled).toBe(true)
    expect(messageBox().value).toBe('How are my labs?')

    send.resolve()

    await waitFor(() => {
      expect(messageBox().disabled).toBe(false)
    })
    expect(messageBox().value).toBe('')
    expect(sendButton().disabled).toBe(true)
  })

  it('should keep the draft and unlock when the send fails', async () => {
    const user = userEvent.setup()
    const send = heldSend()
    renderComposer(send.onSend)

    await user.type(messageBox(), 'Record my weight')
    await user.click(sendButton())
    send.reject()

    await waitFor(() => {
      expect(messageBox().disabled).toBe(false)
    })
    expect(messageBox().value).toBe('Record my weight')
    expect(sendButton().disabled).toBe(false)
  })

  it('should send nothing while a send is still settling', async () => {
    const user = userEvent.setup()
    const send = heldSend()
    renderComposer(send.onSend)

    await user.type(messageBox(), 'Once')
    await user.click(sendButton())
    await user.click(sendButton())

    expect(send.sent).toEqual(['Once'])
  })
})
