import { EventEmitter } from 'eventemitter3';
export interface TunnelOptions {
    port: number;
    host?: string;
    subdomain?: string;
    localHost?: string;
    localHttps?: boolean;
    localCert?: string;
    localKey?: string;
    localCa?: string;
    allowInvalidCert?: boolean;
}
export default class Tunnel extends EventEmitter {
    opts: TunnelOptions;
    closed: boolean;
    url?: string;
    cachedUrl?: string;
    clientId?: string;
    private tunnelCluster?;
    private initController?;
    constructor(opts: TunnelOptions);
    private _getInfo;
    private _init;
    private _establish;
    open(cb: (err?: Error | null) => void): void;
    close(): void;
}
