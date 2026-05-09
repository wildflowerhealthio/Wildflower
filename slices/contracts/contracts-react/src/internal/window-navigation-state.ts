import { Option } from 'effect'

/**
 * A navigation target. `-1` is react-router's back-step sentinel
 * (`navigate(-1)` pops one history entry); a string is a path push.
 */
type NavTarget = -1 | string

type NavigateFunctionRef = React.RefObject<Option.Option<(to: NavTarget) => void>>

// Mutable navigate-binding for `HostBackRequested` and the live
// `HostRequestedWebNavigation` handlers. Module-load handlers fire
// before React's `useNavigate` is available; the layer's handler
// pushes to the queue when `navRef.current === null`, and routes
// through the ref once `<NavigateBinder>` has mounted.
const navigateFunctionRef: NavigateFunctionRef = { current: Option.none() }
const pendingNavigations: NavTarget[] = []

export { navigateFunctionRef, pendingNavigations }
export type { NavigateFunctionRef, NavTarget }
