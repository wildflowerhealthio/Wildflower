import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { HealthViewerLayout } from './health-viewer-layout.tsx'

afterEach(cleanup)

describe('HealthViewerLayout', () => {
  it('should render the panel, the presets, the status line and the chart', () => {
    // Act
    render(
      <HealthViewerLayout
        seriesPanel={<p>panel content</p>}
        selectedSeriesCount={0}
        rangePresets={<p>presets content</p>}
        status={<p>Loading…</p>}
      >
        <p>chart content</p>
      </HealthViewerLayout>
    )

    // Assert
    const panel = screen.getByRole('complementary', { name: 'Series' })
    expect(panel.textContent).toContain('panel content')
    expect(screen.getByText('presets content')).toBeDefined()
    expect(screen.getByText('Loading…')).toBeDefined()
    expect(screen.getByText('chart content')).toBeDefined()
  })

  it('should put the presets and the status line above the chart', () => {
    // Act
    render(
      <HealthViewerLayout
        seriesPanel={null}
        selectedSeriesCount={0}
        rangePresets={<p>presets content</p>}
        status={<p>Loading…</p>}
      >
        <p>chart content</p>
      </HealthViewerLayout>
    )

    // Assert
    const precedes = (earlier: string, later: string): boolean =>
      (screen.getByText(earlier).compareDocumentPosition(screen.getByText(later)) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
      0
    expect(precedes('presets content', 'Loading…')).toBe(true)
    expect(precedes('Loading…', 'chart content')).toBe(true)
  })

  it.each([undefined, null])('should render no status line when status is %s', (status) => {
    // Act
    render(
      <HealthViewerLayout
        seriesPanel={null}
        selectedSeriesCount={0}
        rangePresets={<p>presets content</p>}
        status={status}
      >
        <p>chart content</p>
      </HealthViewerLayout>
    )

    // Assert: the chart column holds only the presets row and the chart.
    const chartColumn = screen.getByText('presets content').parentElement?.parentElement
    expect(chartColumn?.children).toHaveLength(2)
  })

  it.each([0, 1, 3])(
    'should label the narrow-layout disclosure with %i selected',
    (selectedSeriesCount) => {
      // Act
      render(
        <HealthViewerLayout
          seriesPanel={null}
          selectedSeriesCount={selectedSeriesCount}
          rangePresets={null}
        >
          {null}
        </HealthViewerLayout>
      )

      // Assert
      expect(
        screen.getByRole('button', { name: `Series (${selectedSeriesCount} selected)` })
      ).toBeDefined()
    }
  )

  it('should start the disclosure closed and toggle the panel it controls', async () => {
    // Arrange
    const user = userEvent.setup()
    render(
      <HealthViewerLayout
        seriesPanel={<p>panel content</p>}
        selectedSeriesCount={2}
        rangePresets={null}
      >
        {null}
      </HealthViewerLayout>
    )
    const disclosure = screen.getByRole('button', { name: 'Series (2 selected)' })
    const controlledPanel = document.getElementById(disclosure.getAttribute('aria-controls') ?? '')

    // Assert
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(controlledPanel?.textContent).toBe('panel content')

    // Act
    await user.click(disclosure)

    // Assert
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')

    // Act
    await user.click(disclosure)

    // Assert
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  })
})
