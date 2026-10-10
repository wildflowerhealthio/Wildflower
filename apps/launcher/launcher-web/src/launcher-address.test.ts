import { sectionUrl } from 'branding-core'
import { SERVER_QUERY_PARAM } from 'gatekeeper-core/smart-client'
import { describe, expect, it } from 'vite-plus/test'
import launcherRs from '../../../../slices/shared-structures/shared-structures-rust/src/launcher.rs?raw'
import { launcher_base_url as launcherBaseUrl } from '../../../host/host-app/tauri-shared-config.json'
import { RETURN_TO_PARAM } from './sign-in.ts'

// The Tauri host links every browser-facing launcher page (device-flow
// `verification_uri`, logout's landing, the unmatched-route 404) to the
// address in `tauri-shared-config.json` (a debug build, to the dev server on
// `dev-app-ports.json`'s `launcher-dev` port). Rust can't read branding-core, so
// the JSON repeats the published address; this pins the copy to its source.
describe('tauri-shared-config.json launcher address', () => {
  it('should point release builds at the published /launcher section', () => {
    // Arrange
    const published = `${sectionUrl('launcher')}/`

    // Act
    const configured = launcherBaseUrl

    // Assert
    expect(configured).toBe(published)
  })
})

// `shared_structures_rust::launcher` builds the URLs this app is opened with,
// so it has to spell the query parameters the app reads. Rust can't import
// them, so this reads the Rust source and holds both sides to one value.
describe('launcher.rs query parameters', () => {
  it('should name the server parameter the way the app reads it', () => {
    // Arrange
    const source = launcherRustSource()

    // Act
    const rustServerParam = rustStrConst(source, 'SERVER_PARAM')

    // Assert
    expect(rustServerParam).toBe(SERVER_QUERY_PARAM)
  })

  it('should name the return-to parameter the way the landing page reads it', () => {
    // Arrange
    const source = launcherRustSource()

    // Act
    const rustReturnToParam = rustStrConst(source, 'RETURN_TO_PARAM')

    // Assert
    expect(rustReturnToParam).toBe(RETURN_TO_PARAM)
  })
})

// Helpers

const launcherRustSource = (): string => launcherRs

/** The value of `const NAME: &str = "...";` in `source`, or `undefined`. */
const rustStrConst = (source: string, name: string): string | undefined =>
  new RegExp(`const ${name}: &str = "([^"]*)";`).exec(source)?.[1]
