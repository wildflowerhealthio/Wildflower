import { APIConnectionError, RateLimitError } from '@anthropic-ai/sdk'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiKey, Chat, ClaudeModel } from '@wildflowerhealthio/assistant-core-js'
import {
  failingReply,
  heldReply,
  memoryStoragePage,
  messageOf,
  scriptedReply,
  textBlock,
  textDelta,
  thinkingBlock,
  thinkingDelta,
  toolUseBlock,
} from '@wildflowerhealthio/assistant-core-js/test-helpers'
import { answerJson, bundleOf } from '@wildflowerhealthio/fhir-r4-react/smart/test-helpers'
import { Effect, Option } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { GOOD_KEY, PLACE, renderChat, stubDialogMethods } from './assistant-chat.test-helpers.ts'

let restoreDialogMethods: () => void = () => undefined

beforeEach(() => {
  restoreDialogMethods = stubDialogMethods()
})

afterEach(() => {
  cleanup()
  restoreDialogMethods()
})

const keptKey = Option.some(GOOD_KEY)

/** Type `text` into the composer and send it. */
const ask = async (user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> => {
  await user.type(screen.getByLabelText('Message'), text)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

/** A reply that streams `text` in one piece and ends the turn. */
const replyWith = (text: string): ReturnType<typeof scriptedReply> =>
  scriptedReply(
    [textDelta(text)],
    messageOf({ content: [textBlock(text)], stopReason: 'end_turn' })
  )

describe('AssistantChat key setup', () => {
  it('should ask for a key, saying where it goes, before any chat', () => {
    renderChat()

    expect(screen.getByLabelText('Claude API key')).toBeDefined()
    expect(
      screen.getByText('Your key stays in this browser and is only sent to Anthropic.')
    ).toBeDefined()
    expect(screen.queryByLabelText('Message')).toBeNull()
  })

  it("should say a rejected key wasn't accepted, keep it out of storage, and show no chat", async () => {
    const user = userEvent.setup()
    const { page } = renderChat()

    await user.type(screen.getByLabelText('Claude API key'), 'sk-ant-wrong')
    await user.click(screen.getByRole('button', { name: 'Save key' }))

    expect(await screen.findByText("This key wasn't accepted.")).toBeDefined()
    expect(screen.queryByLabelText('Message')).toBeNull()
    expect(page.localStorage.items.has(ApiKey.STORAGE_KEY)).toBe(false)
  })

  it('should keep an accepted key and open the chat on Sonnet 5', async () => {
    const user = userEvent.setup()
    const { page } = renderChat()

    await user.type(screen.getByLabelText('Claude API key'), `  ${GOOD_KEY} `)
    await user.click(screen.getByRole('button', { name: 'Save key' }))

    expect(await screen.findByLabelText('Message')).toBeDefined()
    expect(page.localStorage.items.get(ApiKey.STORAGE_KEY)).toBe(GOOD_KEY)
    expect(screen.getByLabelText<HTMLSelectElement>('Model').value).toBe(ClaudeModel.DEFAULT_ID)
  })

  it('should forget the key from Settings and ask for one again', async () => {
    const user = userEvent.setup()
    const { page } = renderChat({ keptKey })
    await screen.findByLabelText('Message')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Forget key' }))

    expect(await screen.findByLabelText('Claude API key')).toBeDefined()
    expect(page.localStorage.items.has(ApiKey.STORAGE_KEY)).toBe(false)
  })
})

describe('AssistantChat turns', () => {
  it('should show the reply as it streams in, then announce it once finished', async () => {
    const user = userEvent.setup()
    const reply = heldReply()
    renderChat({ keptKey, replies: [reply] })
    await screen.findByLabelText('Message')

    await ask(user, 'How are my labs?')
    reply.send(thinkingDelta('Checking the request.'))
    reply.send(textDelta('Your labs '))
    expect(await screen.findByText('Your labs')).toBeDefined()
    reply.send(textDelta('look **steady**.'))
    expect(await screen.findByText('steady')).toBeDefined()
    reply.finish(
      messageOf({
        content: [thinkingBlock('Checking the request.'), textBlock('Your labs look **steady**.')],
        stopReason: 'end_turn',
      })
    )

    await waitFor(() => {
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Claude replied.')
    })
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1)
    const thinking = screen.getByText('Thinking').closest('details')
    expect(thinking?.open).toBe(false)
    expect(within(thinking!).getByText('Checking the request.')).toBeDefined()
  })

  it('should abort the stream on Stop and keep the question with no reply', async () => {
    const user = userEvent.setup()
    const reply = heldReply()
    const { page } = renderChat({ keptKey, replies: [reply] })
    await screen.findByLabelText('Message')

    await ask(user, 'Tell me everything')
    reply.send(textDelta('Partial answer'))
    await screen.findByText('Partial answer')
    await user.click(screen.getByRole('button', { name: 'Stop' }))

    expect(await screen.findByText('No reply to this message.')).toBeDefined()
    expect(reply.aborted()).toBe(true)
    expect(screen.queryByText('Partial answer')).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDefined()
    expect(Effect.runSync(Chat.read(page, PLACE))).toEqual(
      Option.some({ style: 'telehealth', entries: [Chat.questionOf('Tell me everything')] })
    )
  })

  it('should say Claude declined, and announce it', async () => {
    const user = userEvent.setup()
    renderChat({
      keptKey,
      replies: [
        scriptedReply([textDelta('Part')], messageOf({ content: [], stopReason: 'refusal' })),
      ],
    })
    await screen.findByLabelText('Message')

    await ask(user, 'Something declined')

    expect(
      await screen.findByText('Claude declined to answer this.', { selector: 'li p' })
    ).toBeDefined()
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'Claude declined to answer this.'
    )
  })

  it('should run the next turn on the model picked between turns', async () => {
    const user = userEvent.setup()
    const { claude, page } = renderChat({ keptKey, replies: [replyWith('One'), replyWith('Two')] })
    await screen.findByLabelText('Message')

    await ask(user, 'First')
    await screen.findByText('One')
    await user.selectOptions(screen.getByLabelText('Model'), 'claude-opus-5')
    await ask(user, 'Second')
    await screen.findByText('Two')

    expect(claude.requests.map(({ model }) => model)).toEqual([
      ClaudeModel.DEFAULT_ID,
      'claude-opus-5',
    ])
    expect(page.localStorage.items.get(ClaudeModel.CHOSEN_ID_STORAGE_KEY)).toBe('claude-opus-5')
  })

  it.each([
    [
      new RateLimitError(429, undefined, 'slow down', new Headers()),
      'Your key is over its rate limit. Wait a moment, then try again.',
    ],
    [
      new APIConnectionError({ message: 'offline' }),
      "Couldn't reach Anthropic. Check your connection and try again.",
    ],
  ])('should show why a turn failed above the composer', async (thrown, line) => {
    const user = userEvent.setup()
    renderChat({ keptKey, replies: [failingReply(thrown)] })
    await screen.findByLabelText('Message')

    await ask(user, 'Hello')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(line)
    expect(
      alert.compareDocumentPosition(screen.getByLabelText('Message')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('should pick up the chat kept in the tab', () => {
    const page = memoryStoragePage()
    const kept = Chat.append(Chat.start('academic'), Chat.questionOf('Kept question'))
    Effect.runSync(Chat.write(page, PLACE, kept))

    renderChat({ keptKey, page })

    return screen.findByText('Kept question')
  })
})

describe('AssistantChat style', () => {
  it('should ask before switching to academic, then show its banner above the composer', async () => {
    const user = userEvent.setup()
    renderChat({ keptKey })
    await screen.findByLabelText('Message')

    await user.click(screen.getByRole('button', { name: 'Academic' }))
    expect(
      screen.getByText(
        "This style gives diagnoses and treatment suggestions for teaching. Use it only with sample data, not a real person's record."
      )
    ).toBeDefined()
    expect(screen.queryByRole('note')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Use academic style' }))

    const banner = screen.getByRole('note')
    expect(banner.textContent).toContain('sample data only')
    expect(screen.getByRole('button', { name: 'Academic' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(
      banner.compareDocumentPosition(screen.getByLabelText('Message')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('should stay telehealth when the academic confirmation is cancelled', async () => {
    const user = userEvent.setup()
    renderChat({ keptKey })
    await screen.findByLabelText('Message')

    await user.click(screen.getByRole('button', { name: 'Academic' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('button', { name: 'Telehealth' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('should lock the style once the chat has a message, and free it for a new chat', async () => {
    const user = userEvent.setup()
    const { claude } = renderChat({ keptKey, replies: [replyWith('Hi')] })
    await screen.findByLabelText('Message')

    await ask(user, 'Hello')
    await screen.findByText('Hi')

    expect(screen.getByRole('button', { name: 'Academic' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Telehealth' })).toHaveProperty('disabled', true)
    expect(claude.requests[0]?.system).toContain('telehealth agent')

    await user.click(screen.getByRole('button', { name: 'New chat' }))

    expect(screen.getByRole('button', { name: 'Academic' })).toHaveProperty('disabled', false)
    expect(screen.queryByText('Hello')).toBeNull()
  })
})

describe('AssistantChat tools', () => {
  const searchCall = toolUseBlock('call-1', 'search_records', {
    resourceType: 'Observation',
    params: [{ name: 'code', value: '4548-4' }],
  })
  const a1c = {
    resourceType: 'Observation',
    id: 'o1',
    status: 'final',
    code: { text: 'Hemoglobin A1c' },
    subject: { reference: 'Patient/p1' },
  }

  it("should run Claude's search pinned to the patient, show it as a card, and keep the round", async () => {
    const user = userEvent.setup()
    const { fhir, claude, page } = renderChat({
      keptKey,
      fhirAnswers: { 'Observation?': answerJson(bundleOf([a1c])) },
      replies: [
        scriptedReply([], messageOf({ content: [searchCall], stopReason: 'tool_use' })),
        replyWith('Your A1c is on file.'),
      ],
    })
    await screen.findByLabelText('Message')

    await ask(user, 'What was my A1c?')

    expect(await screen.findByText('Your A1c is on file.')).toBeDefined()
    expect(screen.getByText('Searched Observation: code=4548-4, up to 20')).toBeDefined()
    expect(document.body.textContent).not.toContain('Hemoglobin A1c')
    expect(fhir.urls).toEqual(['https://fhir.example/Observation?code=4548-4&patient=p1&_count=20'])
    expect(claude.requests[1]?.tools).toEqual(claude.requests[0]?.tools)
    const kept = Option.getOrThrow(Effect.runSync(Chat.read(page, PLACE)))
    expect(kept.entries.map(({ _tag }) => _tag)).toEqual([
      'question',
      'reply',
      'tool-results',
      'reply',
    ])
  })

  it('should offer Claude no tools when the grant reaches no records', async () => {
    const user = userEvent.setup()
    const { claude } = renderChat({
      keptKey,
      grantedScopes: ['openid', 'launch'],
      replies: [replyWith('I can’t see your record.')],
    })
    await screen.findByLabelText('Message')

    await ask(user, 'What was my A1c?')
    await screen.findByText('I can’t see your record.')

    expect(claude.requests[0]?.tools).toEqual([])
    expect(claude.requests[0]?.system).toContain("You can't read any records")
  })
})
