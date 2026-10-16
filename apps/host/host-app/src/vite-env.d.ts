/// <reference types="vite-plus/client" />

interface ImportMetaEnv {
  /**
   * The DSN of the base's Sentry project, read by `servers-react`'s
   * `BaseGate` once the user answers its consent dialog; unset, the base
   * reports nothing whatever the answer.
   */
  readonly VITE_SENTRY_DSN_HOST_APP?: string
  /**
   * The platform the Tauri CLI builds the app for (`ios`, `android`,
   * `darwin`, `windows`, `linux`); unset in a build outside it.
   */
  readonly TAURI_ENV_PLATFORM?: string
}
