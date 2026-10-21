import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { PLOT_VIEWS, type ScatterAxes } from '@wildflowerhealthio/plots-core-js'

import { ScatterUnavailableNote, ViewSwitch } from './view-switch.tsx'

afterEach(cleanup)

const paired: ScatterAxes = { kind: 'paired', xSeriesId: 'x', ySeriesId: 'y' }

describe('ViewSwitch', () => {
  it.each(PLOT_VIEWS)('should press only the %s button when it is shown', (view) => {
    // Act
    render(<ViewSwitch shownView={view} scatterAxes={paired} onViewChange={vi.fn()} />)

    // Assert
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual(['Chart', 'Table', 'Scatter'])
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(
      PLOT_VIEWS.map((candidate) => String(candidate === view))
    )
  })

  it('should emit the view whose button is clicked', async () => {
    // Arrange
    const user = userEvent.setup()
    const onViewChange = vi.fn()
    render(<ViewSwitch shownView="chart" scatterAxes={paired} onViewChange={onViewChange} />)

    // Act
    await user.click(screen.getByRole('button', { name: 'Scatter' }))

    // Assert
    expect(onViewChange).toHaveBeenCalledExactlyOnceWith('scatter')
  })

  it.each<ScatterAxes>([
    { kind: 'too-few-value-series', valueSeriesCount: 1 },
    { kind: 'too-many-value-series', valueSeriesCount: 3 },
  ])('should disable only Scatter when the selection makes $kind', (scatterAxes) => {
    // Act
    render(<ViewSwitch shownView="chart" scatterAxes={scatterAxes} onViewChange={vi.fn()} />)

    // Assert
    expect(screen.getByRole('button', { name: 'Chart' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Table' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Scatter' })).toHaveProperty('disabled', true)
  })
})

describe('ScatterUnavailableNote', () => {
  it.each<[ScatterAxes, string]>([
    [{ kind: 'too-few-value-series', valueSeriesCount: 0 }, 'Scatter needs two series selected'],
    [
      { kind: 'too-few-value-series', valueSeriesCount: 1 },
      'Scatter needs one more series selected',
    ],
    [
      { kind: 'too-many-value-series', valueSeriesCount: 3 },
      'Scatter needs only two series selected',
    ],
  ])('should say why for %o', (scatterAxes, reason) => {
    // Act
    render(<ScatterUnavailableNote scatterAxes={scatterAxes} />)

    // Assert
    expect(screen.getByRole('status').textContent).toBe(reason)
  })

  it('should render nothing while a scatter can be drawn', () => {
    // Act
    const { container } = render(<ScatterUnavailableNote scatterAxes={paired} />)

    // Assert
    expect(container.childElementCount).toBe(0)
  })
})
