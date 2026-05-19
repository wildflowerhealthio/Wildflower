/**
 * `BearerToken` was promoted to `kitchen-sink/auth-token` so packages
 * that don't depend on React (e.g. `shared-structures-core`) can wire
 * the bearer-attaching client layer at the slice-core layer. This file
 * re-exports for the slice-react packages that already imported from
 * `react-kitchen-sink`.
 */
export { BearerToken, bearerTokenLayer } from 'kitchen-sink/auth-token'
