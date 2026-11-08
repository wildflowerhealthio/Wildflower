import { type ApiKey, Claude, type StoragePage } from '@wildflowerhealthio/assistant-core-js'
import type { Layer } from 'effect'

/**
 * What the chat runs against: the browser's storage and the Claude API. An
 * app takes {@link BROWSER_ENVIRONMENT}; a test passes in-memory storage and
 * a stub client.
 */
interface AssistantEnvironment {
  /** Where the key, the model choice and the chats are kept: `window` in an app. */
  readonly page: StoragePage
  /** The Claude API as `apiKey` reaches it: `Claude.layerForApiKey` in an app. */
  readonly claudeLayerFor: (apiKey: ApiKey.Type) => Layer.Layer<Claude>
}

/** The page's own `window` storage, and the real Claude API. */
const BROWSER_ENVIRONMENT: AssistantEnvironment = {
  // Read on use, not at import, so importing the package needs no `window`.
  get page(): StoragePage {
    return window
  },
  claudeLayerFor: Claude.layerForApiKey,
}

export { BROWSER_ENVIRONMENT }
export type { AssistantEnvironment }
