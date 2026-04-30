/* oxlint-disable typescript-eslint/no-unsafe-assignment */
/**
 * Smoke test for the public `TunnelOptions` shape — the public field names
 * are camelCase. Field names are validated via TypeScript at compile time;
 * we additionally assert that the field ordering / presence is reflected on
 * a constructed `Tunnel` instance, since that's the surface library users
 * actually touch.
 */

const mockCreateTunnelConnection = jest.fn().mockResolvedValue(undefined)
const mockCloseTunnelConnection = jest.fn().mockResolvedValue(undefined)
const mockCloseAllTunnelConnections = jest.fn().mockResolvedValue(undefined)
const mockAddListener = jest.fn().mockReturnValue({ remove: jest.fn() })

jest.mock('../ExpoLocaltunnelModule', () => ({
  __esModule: true,
  default: {
    createTunnelConnection: mockCreateTunnelConnection,
    closeTunnelConnection: mockCloseTunnelConnection,
    closeAllTunnelConnections: mockCloseAllTunnelConnections,
    addListener: mockAddListener,
  },
}))

import type TunnelType from '../Tunnel.ts'
import type { TunnelOptions } from '../Tunnel.ts'

// `require` (not `import`) — see the analogous note in the sister package's tests.
const Tunnel: typeof TunnelType = require('../Tunnel.ts').default

describe('TunnelOptions public shape', () => {
  test('all documented fields are accepted with camelCase names', () => {
    const opts: TunnelOptions = {
      port: 8000,
      host: 'https://localtunnel.me',
      subdomain: 'mysub',
      localHost: 'localhost',
      localHttps: false,
      localCert: '/path/to/cert',
      localKey: '/path/to/key',
      localCa: '/path/to/ca',
      allowInvalidCert: false,
    }

    const tunnel = new Tunnel(opts)
    expect(tunnel.opts).toMatchObject({
      port: 8000,
      host: 'https://localtunnel.me',
      subdomain: 'mysub',
      localHost: 'localhost',
      localHttps: false,
      localCert: '/path/to/cert',
      localKey: '/path/to/key',
      localCa: '/path/to/ca',
      allowInvalidCert: false,
    })
  })

  test('only `port` is required — every other field is optional', () => {
    const opts: TunnelOptions = { port: 1234 }
    const tunnel = new Tunnel(opts)
    expect(tunnel.opts.port).toBe(1234)
    // `host` defaults inside the Tunnel constructor.
    expect(tunnel.opts.host).toBe('https://localtunnel.me')
  })
})
