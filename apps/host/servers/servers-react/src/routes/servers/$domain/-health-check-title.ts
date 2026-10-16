import { String } from 'effect'

/**
 * A name's words, split at camelCase and PascalCase humps, hyphens,
 * underscores and spaces, each capitalised and joined by a space. A run of
 * capitals stays one word (`HTTPServer` → `HTTP Server`).
 */
const titleWords = (name: string): string =>
  name
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[\s\-_:]+/u)
    .filter(String.isNonEmpty)
    .map(String.capitalize)
    .join(' ')

/**
 * A `/health` check's key, `componentName[:measurementName]`, as a title:
 * each name's words titled (`databaseConnection` → `Database Connection`,
 * `fhir-r4` → `Fhir R4`), with a measurement after its component and a colon
 * (`db:responseTime` → `Db: Response Time`). A key with no words is kept as
 * it is.
 */
const healthCheckTitle = (key: string): string => {
  const separator = key.indexOf(':')
  const names = separator === -1 ? [key] : [key.slice(0, separator), key.slice(separator + 1)]
  const titles = names.map(titleWords).filter(String.isNonEmpty)
  return titles.length === 0 ? key : titles.join(': ')
}

export { healthCheckTitle }
