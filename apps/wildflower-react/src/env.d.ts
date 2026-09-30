/// <reference types="vite-plus/client" />

interface ImportMetaEnv {
  /**
   * The DSN of the owner UI's Sentry project, set by the deploy build and read
   * by the web entry (`main-web`); unset, the web entry reports nothing
   * whatever the visitor answers. The Tauri entry reads the shared
   * `VITE_SENTRY_DSN` instead.
   */
  readonly VITE_SENTRY_DSN_WILDFLOWER_REACT?: string
}

declare module 'scopes-react/styles.css'

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css'
