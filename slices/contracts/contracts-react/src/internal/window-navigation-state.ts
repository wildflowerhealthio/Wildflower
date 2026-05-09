import { Option } from 'effect'

/** Navigation target: `-1` is react-router's back-step sentinel; a string is a path push. */
type NavTarget = -1 | string

type NavigateFunctionRef = React.RefObject<Option.Option<(to: NavTarget) => void>>

// Module-load bridge handlers fire before `useNavigate()` is available; pre-mount
// targets queue here and are drained when `NavigationBridgeHandler` mounts.
const navigateFunctionRef: NavigateFunctionRef = { current: Option.none() }
const pendingNavigations: NavTarget[] = []

export { navigateFunctionRef, pendingNavigations }
export type { NavigateFunctionRef, NavTarget }
