import { Menu, type ItemListItem, type MenuItem, ItemList } from 'react-tundraish'

const accountActions: readonly MenuItem[] = [
  { id: 'edit', label: 'Edit', onSelect: () => {} },
  { id: 'import', label: 'Import Now', onSelect: () => {} },
  { id: 'delete', label: 'Delete', destructive: true, onSelect: () => {} },
]

/**
 * A connected-accounts list — title, a badge, a two-line subtitle, and a
 * trailing per-row `Menu` of actions (collector index). Rows use `onClick`
 * (rather than `href`) so the preview needs no router context.
 */
export const Accounts = () => {
  const items: readonly ItemListItem[] = [
    {
      id: 'demo-fhir',
      title: 'Demo FHIR Server',
      badge: 'FHIR',
      subtitle: 'https://fhir.example.org/r4',
      onClick: () => {},
      actions: <Menu label="Actions for Demo FHIR Server" items={accountActions} />,
    },
    {
      id: 'clinic-epic',
      title: 'Riverside Clinic',
      badge: 'EPIC',
      subtitle: 'https://epic.riverside.example/api/FHIR/R4',
      onClick: () => {},
      actions: <Menu label="Actions for Riverside Clinic" items={accountActions} />,
    },
  ]
  return (
    <div style={{ maxWidth: 420 }}>
      <ItemList title="Accounts" items={items} />
    </div>
  )
}

/** A "connect from" source list, including a disabled "Coming Soon" row. */
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
      badge: 'Coming Soon',
      disabled: true,
      onClick: () => {},
    },
  ]
  return (
    <div style={{ maxWidth: 420 }}>
      <ItemList title="Connect Accounts From" items={items} />
    </div>
  )
}
