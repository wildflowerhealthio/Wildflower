/// <reference types="vite-plus/client" />

interface ImportMetaEnv {
  /**
   * The DSN of the launcher's Sentry project, read by
   * `session/consented-entry-root.tsx`; unset, the launcher reports nothing
   * whatever the user answers.
   */
  readonly VITE_SENTRY_DSN_LAUNCHER_WEB?: string
}

declare module '@wildflowerhealthio/scopes-react/styles.css'

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css'
