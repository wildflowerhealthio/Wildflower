declare module 'tundra-css'
declare module '@wildflowerhealthio/react-tundraish/styles.css'

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css'
