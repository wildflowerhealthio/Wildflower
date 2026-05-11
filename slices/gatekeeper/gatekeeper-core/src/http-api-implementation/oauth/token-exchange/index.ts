import type { Effect, Schema } from 'effect'
import type { Origin } from 'navigation-core'
import type { GatekeeperStore } from '../../../contexts/gatekeeper-store.ts'
import type {
  AuthorizationCodePayload,
  DeviceCodePayload,
} from '../../../http-api-definition/oauth.ts'
import type { OAuthError400, OAuthError401, OAuthError500, TokenResponse } from '../shared.ts'
import { handleAuthorizationCodeTokenExchange } from './authorization-code.ts'
import { handleDeviceCodeTokenExchange } from './device-code.ts'

type TokenExchangePayload = Schema.Schema.Type<
  typeof AuthorizationCodePayload | typeof DeviceCodePayload
>

const handleTokenExchange = (
  payload: TokenExchangePayload
): Effect.Effect<
  TokenResponse,
  OAuthError400 | OAuthError401 | OAuthError500,
  GatekeeperStore | Origin
> => {
  if (payload.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
    return handleDeviceCodeTokenExchange(payload)
  }
  return handleAuthorizationCodeTokenExchange(payload)
}

export { handleTokenExchange }
