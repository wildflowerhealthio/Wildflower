/// <reference types="vite-plus/client" />

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css'

declare module '*.png' {
  const src: string
  export default src
}
