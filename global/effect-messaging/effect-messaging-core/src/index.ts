export { BareSender, type BareSenderFunction, type BareSenderService } from './bare-sender.ts'
export * as Bridge from './bridge.ts'
export * as BridgeTransport from './bridge-transport.ts'
export * as DispatchError from './dispatch-error.ts'
export * as Message from './message.ts'
export * as MessageHandler from './message-handler.ts'
export * as HostBinding from './host-binding.ts'
// Top-level type re-export so downstream d.ts emission (tsgo) has a
// portable path to the `HostBinding<B>` type rather than reaching for
// the deep `./src/host-binding.ts` file. The namespace export above
// stays — value-space (`aggregate`, `callTransportReady`) and other
// types (`HostBinding.Any`, `HostBinding.BindingSend`, …) still resolve
// through it.
export type { HostBinding as HostBindingType } from './host-binding.ts'
export { TransportAdapter, REACT_NATIVE_WEBVIEW_GLOBAL } from './transport-adapter.ts'
export * as TestPlatformAdapterLayer from './test-platform-adapter-layer.ts'
export * as UrlParamMessage from './url-param-message.ts'
