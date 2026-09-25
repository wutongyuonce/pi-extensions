import type { Socket, Server } from 'node:net';
import type { Duplex } from 'node:stream';
export interface HttpProxyServerOptions {
    filter(port: number, host: string, socket: Socket | Duplex): Promise<boolean> | boolean;
}
export declare function createHttpProxyServer(options: HttpProxyServerOptions): Server;
//# sourceMappingURL=http-proxy.d.ts.map