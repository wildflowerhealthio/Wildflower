import { useState } from 'react'
import { SegmentedToggle } from 'react-tundraish'

type Tab = 'medications' | 'calendar' | 'interactions' | 'savings'

/** The medications-app view switcher in its page header. */
export const Views = () => {
  const [tab, setTab] = useState<Tab>('medications')
  return (
    <SegmentedToggle
      aria-label="View"
      value={tab}
      onChange={setTab}
      options={[
        { value: 'medications', label: 'Medications' },
        { value: 'calendar', label: 'Calendar' },
        { value: 'interactions', label: 'Interactions' },
        { value: 'savings', label: 'Savings' },
      ]}
    />
  )
}

type Range = '7d' | '30d' | '90d' | '1y'

/** Short-label range presets (health-viewer), a middle option pressed. */
export const RangePresets = () => {
  const [range, setRange] = useState<Range>('30d')
  return (
    <SegmentedToggle
      aria-label="Range"
      value={range}
      onChange={setRange}
      options={[
        { value: '7d', label: '7 days' },
        { value: '30d', label: '30 days' },
        { value: '90d', label: '90 days' },
        { value: '1y', label: '1 year' },
      ]}
    />
  )
}

/** In a page header row beside the title, as apps lay it out. */
export const InHeader = () => {
  const [tab, setTab] = useState<'import' | 'anonymize'>('import')
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, maxWidth: 480 }}>
      <h1 className="text-heading-3" style={{ margin: 0 }}>
        Importer
      </h1>
      <SegmentedToggle
        aria-label="Mode"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'import', label: 'Import' },
          { value: 'anonymize', label: 'Anonymize' },
        ]}
      />
    </div>
  )
}
