import { PageHeader } from 'react-tundraish'

/** Top-level surface: just a title, no back affordance (a tab destination). */
export const TopLevel = () => (
  <div style={{ maxWidth: 480 }}>
    <PageHeader title="Collector" />
  </div>
)

/** A detail page: a record subtitle under the title (a URL or per-record id). */
export const WithSubtitle = () => (
  <div style={{ maxWidth: 480 }}>
    <PageHeader title="Request" subtitle="POST https://api.example.com/v1/grants" />
  </div>
)

/** Trailing actions slot — a "Manage" control aligned to the end (apps home). */
export const WithActions = () => (
  <div style={{ maxWidth: 480 }}>
    <PageHeader
      title="Apps"
      actions={
        <button type="button" className="button-2 outline">
          Manage
        </button>
      }
    />
  </div>
)

/** A long title truncates on a single line rather than wrapping the header taller. */
export const Truncating = () => (
  <div style={{ maxWidth: 280 }}>
    <PageHeader
      title="Edit Demo FHIR Server account configuration"
      subtitle="https://fhir.example.org/r4/very/long/base/url/that/overflows"
    />
  </div>
)
