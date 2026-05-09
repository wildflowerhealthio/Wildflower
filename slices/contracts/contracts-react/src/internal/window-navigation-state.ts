import { Option } from 'effect'

type NavigateFunctionRef = React.RefObject<Option.Option<(to: -1 | string) => void>>

// Mutable navigate-binding for `HostBackRequested` and the live
// `HostRequestedWebNavigation` handlers. Module-load handlers fire
// before React's `useNavigate` is available; the layer's handler
// pushes to the queue when `navRef.current === null`, and routes
// through the ref once `<NavigateBinder>` has mounted.
const navigateFunctionRef: NavigateFunctionRef = { current: Option.none() }
const pendingNavigations: Array<-1 | string> = []

export { navigateFunctionRef, pendingNavigations }
export type { NavigateFunctionRef }
