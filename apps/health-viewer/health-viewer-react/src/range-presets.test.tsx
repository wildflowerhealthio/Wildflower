import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { RANGE_PRESETS } from '@wildflowerhealthio/health-viewer-core-js'

import { RangePresets } from './range-presets.tsx'

afterEach(cleanup)

/** The preset buttons, which render in core's {@link RANGE_PRESETS} order. */
const presetButtons = (): readonly HTMLElement[] => {
  const buttons = screen.getAllByRole('button')
  expect(buttons).toHaveLength(RANGE_PRESETS.length)
  return buttons
}

describe('RangePresets', () => {
  it.each(RANGE_PRESETS)('should press only the %s button when it is the value', (preset) => {
    // Act
    render(<RangePresets selectedPreset={preset} onPresetChange={vi.fn()} />)

    // Assert
    const pressedStates = presetButtons().map((button) => button.getAttribute('aria-pressed'))
    expect(pressedStates).toEqual(RANGE_PRESETS.map((candidate) => String(candidate === preset)))
  })

  it.each(RANGE_PRESETS)('should emit %s when its button is clicked', async (preset) => {
    // Arrange
    const user = userEvent.setup()
    const onPresetChange = vi.fn()
    const otherPreset = RANGE_PRESETS.find((candidate) => candidate !== preset) ?? preset
    render(<RangePresets selectedPreset={otherPreset} onPresetChange={onPresetChange} />)
    const button = presetButtons()[RANGE_PRESETS.indexOf(preset)]
    if (button === undefined) throw new Error(`No button for ${preset}`)

    // Act
    await user.click(button)

    // Assert
    expect(onPresetChange).toHaveBeenCalledExactlyOnceWith(preset)
  })

  it('should list the windows longest first, down to the device-scale ones', () => {
    // Act
    render(<RangePresets selectedPreset="all" onPresetChange={vi.fn()} />)

    // Assert
    expect(presetButtons().map((button) => button.textContent)).toEqual([
      'All',
      '5y',
      '1y',
      '90d',
      '28d',
      '7d',
      '24h',
    ])
  })

  it('should label the default preset "All" and name the group for assistive tech', () => {
    // Act
    render(<RangePresets selectedPreset="all" onPresetChange={vi.fn()} />)

    // Assert
    expect(screen.getByRole('group', { name: 'Range' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'All', pressed: true })).toBeDefined()
  })
})
