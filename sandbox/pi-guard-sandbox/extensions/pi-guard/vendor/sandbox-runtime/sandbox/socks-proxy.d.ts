import type { Socks5Server } from '@pondwader/socks5-server';
export interface SocksProxyServerOptions {
    filter(port: number, host: string): Promise<boolean> | boolean;
}
export interface SocksProxyWrapper {
    server: Socks5Server;
    getPort(): number | undefined;
    listen(port: number, hostname: string): Promise<number>;
    close(): Promise<void>;
    unref(): void;
}
export declare function createSocksProxyServer(options: SocksProxyServerOptions): SocksProxyWrapper;
//# sourceMappingURL=socks-proxy.d.ts.map