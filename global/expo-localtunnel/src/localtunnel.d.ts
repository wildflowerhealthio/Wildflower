import Tunnel, { type TunnelOptions } from './Tunnel.ts';
type Callback = (err: Error | null, tunnel?: Tunnel) => void;
/**
 * Open a localtunnel using an options object. Returns a Promise that resolves to the
 * connected `Tunnel`, or rejects on failure.
 */
export default function localtunnel(opts: TunnelOptions): Promise<Tunnel>;
/**
 * Open a localtunnel using an options object. Invokes `callback` once the tunnel is
 * connected (or with an error). Returns the `Tunnel` instance synchronously so callers
 * can attach listeners before connection completes.
 */
export default function localtunnel(opts: TunnelOptions, callback: Callback): Tunnel;
/**
 * Open a localtunnel for the given local `port`. Returns a Promise that resolves to the
 * connected `Tunnel`, or rejects on failure.
 */
export default function localtunnel(port: number, opts?: Omit<TunnelOptions, 'port'>, callback?: undefined): Promise<Tunnel>;
/**
 * Open a localtunnel for the given local `port`. Invokes `callback` once the tunnel is
 * connected (or with an error). Returns the `Tunnel` instance synchronously so callers
 * can attach listeners before connection completes.
 */
export default function localtunnel(port: number, opts: Omit<TunnelOptions, 'port'> | undefined, callback: Callback): Tunnel;
export {};
