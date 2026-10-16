import { String } from 'effect'

/**
 * A `/health` check's key, `componentName[:measurementName]`, as a title:
 * its words, split at camelCase and PascalCase humps, hyphens, underscores,
 * colons and spaces, each capitalised and joined by a space
 * (`databaseConnection` → `Database Connection`, `fhir-r4` → `Fhir R4`,
 * `db:responseTime` → `Db Response Time`). A run of capitals stays one word
 * (`HTTPServer` → `HTTP Server`). A key with no words is kept as it is.
 */
const healthCheckTitle = (key: string): string => {
  const words = key
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[\s\-_:]+/u)
    .filter(String.isNonEmpty)
  return words.length === 0 ? key : words.map(String.capitalize).join(' ')
}

export { healthCheckTitle }
