import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { ReplyMarkdown } from './reply-markdown.tsx'

afterEach(cleanup)

describe('ReplyMarkdown', () => {
  it('should render GitHub-flavoured Markdown: emphasis, lists and tables', () => {
    const { container } = render(
      <ReplyMarkdown
        markdown={'**Bold** text\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |'}
      />
    )

    expect(container.querySelector('strong')?.textContent).toBe('Bold')
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['one', 'two'])
    expect(screen.getByRole('table')).toBeDefined()
  })

  it('should skip raw HTML rather than render it', () => {
    const { container } = render(
      <ReplyMarkdown
        markdown={
          'Before <script>alert(1)</script> <b onclick="x()">bold</b>\n\n<iframe src="https://evil.example"></iframe>\n\nAfter'
        }
      />
    )

    expect(container.querySelector('script, b, iframe, [onclick]')).toBeNull()
    expect(container.textContent).toContain('Before')
    expect(container.textContent).toContain('After')
  })

  it('should open an https link in a new tab with no hold on this one', () => {
    render(<ReplyMarkdown markdown="[the guide](https://example.org/guide)" />)

    const link = screen.getByRole('link', { name: 'the guide' })
    expect([
      link.getAttribute('href'),
      link.getAttribute('target'),
      link.getAttribute('rel'),
    ]).toEqual(['https://example.org/guide', '_blank', 'noopener noreferrer'])
  })

  it.each([
    'javascript:alert(document.cookie)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://example.org/plain',
    '/relative/path',
    'mailto:someone@example.org',
  ])('should keep the text of a link to %s but no link', (url) => {
    const { container } = render(<ReplyMarkdown markdown={`[click me](${url})`} />)

    expect(screen.queryByRole('link')).toBeNull()
    expect(container.querySelector('[href]')).toBeNull()
    expect(container.textContent).toContain('click me')
  })

  it('should not render images, even from https', () => {
    const { container } = render(
      <ReplyMarkdown markdown="![chart](https://example.org/leak.png?data=secret)" />
    )

    expect(container.querySelector('img')).toBeNull()
  })
})
