/// <reference types="vite-plus/client" />

declare module 'scopes-react/styles.css'

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css'
