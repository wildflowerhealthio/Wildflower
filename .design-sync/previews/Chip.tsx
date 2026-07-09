import { Chip, PageHeader } from 'react-tundraish'

/** The canonical use — a maturity tag riding inline inside a page title. */
export const InTitle = () => (
  <div style={{ maxWidth: 420 }}>
    <PageHeader
      title={
        <>
          Relay settings
        </>
      }
      actions={<Chip>Advanced</Chip>}
    />
  </div>
)

/** The family of labels a chip typically carries — natural case in, uppercase out. */
export const Tags = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <Chip>Advanced</Chip>
    <Chip>Beta</Chip>
    <Chip>Preview</Chip>
    <Chip>New</Chip>
  </div>
)

/** Beside a heading, marking the scope of the section below it. */
export const NextToHeading = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
    <span className="text-heading-4">Connections</span>
    <Chip>Experimental</Chip>
  </div>
)
