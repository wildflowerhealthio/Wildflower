import type { HttpServerResponse } from '@effect/platform'
import { Context } from 'effect'

interface AuthRendererInterface {
  oauthPollingPage: (input: {
    code: string
    clientId: string
    statusUrl: string
  }) => HttpServerResponse.HttpServerResponse
  oauthError: (input: {
    kind: 'unsupported_code_challenge' | 'invalid_redirect_uri' | 'invalid_scheme'
    method?: string
  }) => HttpServerResponse.HttpServerResponse
  pinPage: (input: {
    id: string
    pin: string
    statusUrl: string
    timeoutMs: number
  }) => HttpServerResponse.HttpServerResponse
  pinError: (input: { kind: 'invalid_returnTo' }) => HttpServerResponse.HttpServerResponse
}

class AuthRenderer extends Context.Tag('AuthRenderer')<AuthRenderer, AuthRendererInterface>() {}

export { AuthRenderer }
export type { AuthRendererInterface }
