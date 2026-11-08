import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Option } from 'effect'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { ToolCallCard } from './tool-call-card.tsx'

afterEach(cleanup)

const call = {
  type: 'tool_use' as const,
  id: 'call-1',
  name: 'search_records',
  input: { resourceType: 'Observation', params: [{ name: 'code', value: '4548-4' }] },
}

const result = Option.some({
  type: 'tool_result' as const,
  tool_use_id: 'call-1',
  content: JSON.stringify({
    resources: [
      { resourceType: 'Observation', id: 'o1', valueString: 'Ada Lovelace private note' },
    ],
    more: false,
  }),
})

describe('ToolCallCard', () => {
  it('should show one line, closed, then open to the parameters and the result count', async () => {
    const user = userEvent.setup()
    render(<ToolCallCard call={call} result={result} />)

    const summary = screen.getByText('Searched Observation: code=4548-4, up to 20')
    const card = summary.closest('details')
    expect(card?.open).toBe(false)

    await user.click(summary)

    expect(card?.open).toBe(true)
    expect(screen.getByText('code').nextElementSibling?.textContent).toBe('4548-4')
    expect(screen.getByText('1 record')).toBeDefined()
  })

  it("should never show the records' contents", () => {
    const { container } = render(<ToolCallCard call={call} result={result} open />)

    expect(container.textContent).not.toContain('Ada Lovelace private note')
  })

  it('should say a call that never came back has no result', () => {
    render(<ToolCallCard call={call} result={Option.none()} open />)

    expect(screen.getByText('No result')).toBeDefined()
  })
})
