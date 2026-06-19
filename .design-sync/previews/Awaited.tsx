import { useMemo } from 'react'
import { Awaited } from 'react-tundraish'

type Account = { readonly id: string; readonly name: string; readonly status: string }

/**
 * The resolved path — `Awaited` suspends on `promise`, then renders the
 * resolved value through the `children` render-prop. The preview hands it an
 * already-resolved promise so the cell shows the success state a static
 * preview can capture (the loading and error states are transient).
 */
export const Resolved = () => {
  const promise = useMemo<Promise<readonly Account[]>>(
    () =>
      Promise.resolve([
        { id: 'a1', name: 'Demo FHIR Server', status: 'Connected' },
        { id: 'a2', name: 'Riverside Clinic', status: 'Syncing' },
      ]),
    [],
  )
  return (
    <div style={{ maxWidth: 420 }}>
      <Awaited promise={promise}>
        {(accounts) => (
          <ul style={{ display: 'grid', gap: 8, listStyle: 'none', padding: 0, margin: 0 }}>
            {accounts.map((a) => (
              <li
                key={a.id}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}
              >
                <span className="text-body-2">{a.name}</span>
                <span className="text-label-3">{a.status}</span>
              </li>
            ))}
          </ul>
        )}
      </Awaited>
    </div>
  )
}
