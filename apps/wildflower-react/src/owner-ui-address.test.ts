import { sectionUrl } from 'branding-core'
import { SERVER_QUERY_PARAM } from 'gatekeeper-core/smart-client'
import { describe, expect, it } from 'vite-plus/test'
import ownerUiRs from '../../../slices/shared-structures/shared-structures-rust/src/owner_ui.rs?raw'
import {
  owner_ui_base_url as ownerUiBaseUrl,
  owner_ui_dev_base_url as ownerUiDevBaseUrl,
} from '../../wildflower-tauri/tauri-shared-config.json'
import { RETURN_TO_PARAM } from './sign-in.ts'

// The Tauri host links every browser-facing owner-UI page (device-flow
// `verification_uri`, `/authorize` polling page, the unmatched-route 404) to the
// address in `tauri-shared-config.json`. Rust can't read branding-core, so the
// JSON repeats the published address; these pin the copy to its source.
describe('tauri-shared-config.json owner UI address', () => {
  it('should point release builds at the published /app section', () => {
    // Arrange
    const published = `${sectionUrl('app')}/`

    // Act
    const configured = ownerUiBaseUrl

    // Assert
    expect(configured).toBe(published)
  })

  it('should point debug builds at the local main-web dev server root', () => {
    // Arrange
    const url = new URL(ownerUiDevBaseUrl)

    // Act
    const { hostname, pathname, port } = url

    // Assert
    expect({ hostname, pathname, portIsSet: port !== '' }).toEqual({
      hostname: 'localhost',
      pathname: '/',
      portIsSet: true,
    })
  })
})

// `shared_structures_rust::owner_ui` builds the URLs this app is opened with,
// so it has to spell the query parameters the app reads. Rust can't import
// them, so this reads the Rust source and holds both sides to one value.
describe('owner_ui.rs query parameters', () => {
  it('should name the server parameter the way the app reads it', () => {
    // Arrange
    const source = ownerUiRustSource()

    // Act
    const rustServerParam = rustStrConst(source, 'SERVER_PARAM')

    // Assert
    expect(rustServerParam).toBe(SERVER_QUERY_PARAM)
  })

  it('should name the return-to parameter the way the landing page reads it', () => {
    // Arrange
    const source = ownerUiRustSource()

    // Act
    const rustReturnToParam = rustStrConst(source, 'RETURN_TO_PARAM')

    // Assert
    expect(rustReturnToParam).toBe(RETURN_TO_PARAM)
  })
})

// Helpers

const ownerUiRustSource = (): string => ownerUiRs

/** The value of `const NAME: &str = "...";` in `source`, or `undefined`. */
const rustStrConst = (source: string, name: string): string | undefined =>
  new RegExp(`const ${name}: &str = "([^"]*)";`).exec(source)?.[1]
