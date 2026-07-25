import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { URL } from 'node:url';
import { logForDebugging } from '../utils/debug.js';
export function createHttpProxyServer(options) {
    const server = createServer();
    // Handle CONNECT requests for HTTPS traffic
    server.on('connect', async (req, socket) => {
        // Attach error handler immediately to prevent unhandled errors
        socket.on('error', err => {
            logForDebugging(`Client socket error: ${err.message}`, { level: 'error' });
        });
        try {
            const [hostname, portStr] = req.url.split(':');
            const port = portStr === undefined ? undefined : parseInt(portStr, 10);
            if (!hostname || !port) {
                logForDebugging(`Invalid CONNECT request: ${req.url}`, {
                    level: 'error',
                });
                socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
                return;
            }
            const allowed = await options.filter(port, hostname, socket);
            if (!allowed) {
                logForDebugging(`Connection blocked to ${hostname}:${port}`, {
                    level: 'error',
                });
                socket.end('HTTP/1.1 403 Forbidden\r\n' +
                    'Content-Type: text/plain\r\n' +
                    'X-Proxy-Error: blocked-by-allowlist\r\n' +
                    '\r\n' +
                    'Connection blocked by network allowlist');
                return;
            }
            const serverSocket = connect(port, hostname, () => {
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                serverSocket.pipe(socket);
                socket.pipe(serverSocket);
            });
            serverSocket.on('error', err => {
                logForDebugging(`CONNECT tunnel failed: ${err.message}`, {
                    level: 'error',
                });
                socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            });
            socket.on('error', err => {
                logForDebugging(`Client socket error: ${err.message}`, {
                    level: 'error',
                });
                serverSocket.destroy();
            });
            socket.on('end', () => serverSocket.end());
            serverSocket.on('end', () => socket.end());
        }
        catch (err) {
            logForDebugging(`Error handling CONNECT: ${err}`, { level: 'error' });
            socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        }
    });
    // Handle regular HTTP requests
    server.on('request', async (req, res) => {
        try {
            const url = new URL(req.url);
            const hostname = url.hostname;
            const port = url.port
                ? parseInt(url.port, 10)
                : url.protocol === 'https:'
                    ? 443
                    : 80;
            const allowed = await options.filter(port, hostname, req.socket);
            if (!allowed) {
                logForDebugging(`HTTP request blocked to ${hostname}:${port}`, {
                    level: 'error',
                });
                res.writeHead(403, {
                    'Content-Type': 'text/plain',
                    'X-Proxy-Error': 'blocked-by-allowlist',
                });
                res.end('Connection blocked by network allowlist');
                return;
            }
            // Choose http or https module
            const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
            const proxyReq = requestFn({
                hostname,
                port,
                path: url.pathname + url.search,
                method: req.method,
                headers: {
                    ...req.headers,
                    host: url.host,
                },
            }, proxyRes => {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res);
            });
            proxyReq.on('error', err => {
                logForDebugging(`Proxy request failed: ${err.message}`, {
                    level: 'error',
                });
                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'text/plain' });
                    res.end('Bad Gateway');
                }
            });
            req.pipe(proxyReq);
        }
        catch (err) {
            logForDebugging(`Error handling HTTP request: ${err}`, { level: 'error' });
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
        }
    });
    return server;
}
//# sourceMappingURL=http-proxy.js.map