/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The DSN of this app's Sentry project, set by the deploy build; unset, the
   * app reports nothing whatever the visitor answers.
   */
  readonly VITE_SENTRY_DSN_MEDICATIONS_WEB?: string
}

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css'
