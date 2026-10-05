/**
 * Query-key roots of the relay admin screen. Every key starts with
 * {@link RELAY_QUERY_KEY}, so signing out drops them all at once.
 */

const RELAY_QUERY_KEY = ['relay'] as const
const ADMIN_KEY_QUERY_KEY = ['relay', 'admin-key'] as const
const TUNNELS_QUERY_KEY = ['relay', 'tunnels'] as const

export { ADMIN_KEY_QUERY_KEY, RELAY_QUERY_KEY, TUNNELS_QUERY_KEY }
