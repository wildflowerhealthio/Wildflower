/// <reference types="vite-plus/client" />

interface ImportMetaEnv {
  /**
   * The DSN of the base's Sentry project, read by `servers-react`'s
   * `BaseRoot` once the user answers its consent dialog; unset, the base
   * reports nothing whatever the answer.
   */
  readonly VITE_SENTRY_DSN_WILDFLOWER_TAURI?: string
}
