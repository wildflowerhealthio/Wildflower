import { Menu, type ItemListItem, type MenuItem, ItemList, StatusBadge } from 'react-tundraish'

const accountActions: readonly MenuItem[] = [
  { id: 'edit', label: 'Edit', onSelect: () => {} },
  { id: 'import', label: 'Import Now', onSelect: () => {} },
  { id: 'delete', label: 'Delete', destructive: true, onSelect: () => {} },
]

/**
 * A connected-accounts list — each row carries a `badge`, a two-line
 * `subtitle`, a `meta` column, and a trailing per-row `Menu` of actions
 * (collector index). Rows use `onClick` rather than `href`, so the preview
 * needs no router context.
 */
export const Accounts = () => {
  const items: readonly ItemListItem[] = [
    {
      id: 'demo-fhir',
      title: 'Demo FHIR Server',
      badge: <StatusBadge tone="success">Connected</StatusBadge>,
      subtitle: 'https://fhir.example.org/r4',
      meta: 'Synced 2h ago',
      onClick: () => {},
      actions: <Menu label="Actions for Demo FHIR Server" items={accountActions} />,
    },
    {
      id: 'clinic-epic',
      title: 'Riverside Clinic',
      badge: <StatusBadge tone="warning">Token expiring</StatusBadge>,
      subtitle: 'https://epic.riverside.example/api/FHIR/R4',
      meta: 'Synced 3d ago',
      onClick: () => {},
      actions: <Menu label="Actions for Riverside Clinic" items={accountActions} />,
    },
  ]
  return (
    <div style={{ maxWidth: 440 }}>
      <ItemList title="Accounts" items={items} />
    </div>
  )
}

/**
 * A `leading` icon slot plus a `danger`-tone row — the way a list marks a
 * revoked or at-risk entry with a faint background tint.
 */
export const WithLeadingAndTone = () => {
  const items: readonly ItemListItem[] = [
    {
      id: 'app-1',
      title: 'Patient Portal',
      leading: (
        <span aria-hidden style={{ fontSize: 18 }}>
          🩺
        </span>
      ),
      subtitle: 'patient.read · observation.read',
      onClick: () => {},
    },
    {
      id: 'app-2',
      title: 'Legacy Sync Agent',
      leading: (
        <span aria-hidden style={{ fontSize: 18 }}>
          ⚠️
        </span>
      ),
      subtitle: 'Full access · last used 240 days ago',
      tone: 'danger',
      onClick: () => {},
    },
  ]
  return (
    <div style={{ maxWidth: 440 }}>
      <ItemList title="Approved Apps" items={items} />
    </div>
  )
}

/** A "connect from" source list, including a disabled "Coming soon" row. */
export const Sources = () => {
  const items: readonly ItemListItem[] = [
    {
      id: 'demo-fhir',
      title: 'Demo FHIR Server',
      subtitle: 'A public sandbox to try out an import',
      onClick: () => {},
    },
    {
      id: 'rexall',
      title: 'Rexall Pharmacy',
      subtitle: 'Prescription and pharmacy records',
      badge: 'Coming soon',
      disabled: true,
    },
  ]
  return (
    <div style={{ maxWidth: 440 }}>
      <ItemList title="Connect Accounts From" items={items} />
    </div>
  )
}
