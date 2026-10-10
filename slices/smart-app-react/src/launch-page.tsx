import { BrandBar } from 'branding-react'
import type { JSX } from 'react'
import { PageLoading } from 'react-tundraish'

/**
 * The launch page: the slim `BrandBar` over one loading line — the shape
 * `BrandBar` exists for, and the same `PageLoading` the desktop app shows while
 * its own handshake is in flight.
 *
 * @param message - The loading line, e.g. `Launching Importer…`.
 */
function LaunchPage({ message }: { readonly message: string }): JSX.Element {
  return (
    <>
      <BrandBar />
      <main>
        <PageLoading message={message} />
      </main>
    </>
  )
}

export { LaunchPage }
