import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'

// Read from disk: Vitest stubs CSS imports, `?raw` included, to an empty string.
const read = (relative: string): string => readFileSync(join(import.meta.dirname, relative), 'utf8')

describe('index.html', () => {
  it('should paint the design system canvas in both color schemes before the bundle loads', () => {
    // Arrange — the canvas colors, read from the palette so this fails if they move.
    const palette = read('../../../global/react-tundraish/src/colors-custom.css')
    const canvases = [...palette.matchAll(/--color-canvas:\s*(#[0-9a-f]{3,8})/gi)].map(
      ([, hex]) => hex ?? ''
    )
    expect(canvases).toHaveLength(2)
    const [light, dark] = canvases

    // Act
    const [base, darkBlock] = read('../index.html').split('@media (prefers-color-scheme: dark)')

    // Assert — a page load shows the canvas, not white, until the CSS arrives.
    expect(base).toContain(`background-color: ${light}`)
    expect(darkBlock).toContain(`background-color: ${dark}`)
  })
})
