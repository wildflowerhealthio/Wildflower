import { EventEmitter } from 'eventemitter3';
export interface TunnelClusterOpts {
    remoteHost: string;
    remoteIp?: string;
    remotePort: number;
    localHost?: string;
    localPort: number;
}
export default class TunnelCluster extends EventEmitter {
    private opts;
    private connections;
    private _subscriptions;
    constructor(opts: TunnelClusterOpts);
    private _setupNativeListeners;
    open(): void;
    close(): void;
}
