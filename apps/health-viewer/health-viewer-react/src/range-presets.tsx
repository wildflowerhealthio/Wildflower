import { SegmentedToggle, type SegmentedToggleOption } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { RANGE_PRESETS, type RangePreset } from '@wildflowerhealthio/health-viewer-core-js'

/** What each preset's button reads. A `Record` so a new preset is a type error here. */
const PRESET_LABELS: Readonly<Record<RangePreset, string>> = {
  all: 'All',
  '5y': '5y',
  '1y': '1y',
  '90d': '90d',
  '28d': '28d',
  '7d': '7d',
  '24h': '24h',
}

/** The buttons, in core's picker order. */
const PRESET_OPTIONS: readonly SegmentedToggleOption<RangePreset>[] = RANGE_PRESETS.map(
  (preset) => ({ value: preset, label: PRESET_LABELS[preset] })
)

interface RangePresetsProps {
  /** The window currently drawn along the x axis. */
  readonly selectedPreset: RangePreset
  /** Called with the preset whose button was pressed. */
  readonly onPresetChange: (preset: RangePreset) => void
}

/**
 * The x-axis window picker: one `aria-pressed` button per
 * {@link RANGE_PRESETS} entry, exactly one pressed. A thin binding of
 * `react-tundraish`'s `SegmentedToggle` to the core's preset list, so the
 * picker's order and choices are the core's, not this component's.
 */
const RangePresets = ({ selectedPreset, onPresetChange }: RangePresetsProps): JSX.Element => (
  <SegmentedToggle
    value={selectedPreset}
    options={PRESET_OPTIONS}
    onChange={onPresetChange}
    aria-label="Range"
  />
)

export { RangePresets }
export type { RangePresetsProps }
