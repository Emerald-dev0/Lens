/** Network helpers: port discovery and dev-server readiness probing. */
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

export interface PortProbeResult {
  port: number;
  host: string;
  open: boolean;
  durationMs: number;
}

export async function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 350): Promise<boolean> {
  return (await probePort(port, host, timeoutMs)).open;
}

export function probePort(port: number, host = '127.0.0.1', timeoutMs = 350): Promise<PortProbeResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ port, host, open, durationMs: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

/** Scan a list of candidate ports, returning every open one. */
export async function scanPorts(ports: number[], host = '127.0.0.1'): Promise<number[]> {
  const results = await Promise.all(ports.map(async (p) => ({ p, open: await isPortOpen(p, host) })));
  return results.filter((r) => r.open).map((r) => r.p);
}

export interface UrlProbeResult {
  ok: boolean;
  status: number | null;
  headers: Record<string, string>;
  error?: string;
}

/**
 * A URL is "reachable" when it answers with any HTTP status — a 404 from a live
 * dev server still proves the server exists. Lens only needs to know whether to
 * offer "start your dev server" as the remedy.
 */
export function probeUrl(rawUrl: string, timeoutMs = 1500): Promise<UrlProbeResult> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (err) {
      resolve({ ok: false, status: null, headers: {}, error: (err as Error).message });
      return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      { method: 'GET', headers: { accept: '*/*' }, timeout: timeoutMs },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
        }
        res.resume();
        resolve({ ok: true, status: res.statusCode ?? null, headers });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => {
      resolve({ ok: false, status: null, headers: {}, error: (err as Error).message });
    });
    req.end();
  });
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ParsedTarget {
  url: string;
  origin: string;
  host: string;
  hostname: string;
  port: number | null;
  protocol: string;
  path: string;
}

/** Parse `url`, `host:port`, `:port` or `path` shorthand into a navigation target. */
export function parseTarget(input: string, defaults: { protocol?: string; host?: string; port?: number } = {}): ParsedTarget {
  const protocol = defaults.protocol ?? 'http';
  const host = defaults.host ?? '127.0.0.1';
  let candidate = input.trim();

  if (/^\d{2,5}$/.test(candidate)) {
    candidate = `${protocol}://${host}:${candidate}`;
  } else if (/^:\d{2,5}(\/.*)?$/.test(candidate)) {
    const [portPart, rest] = candidate.slice(1).split(/(?=\/)/);
    candidate = `${protocol}://${host}:${portPart}${rest ?? ''}`;
  } else if (/^(localhost|\d+\.\d+\.\d+\.\d+|\[?::1\]?|[a-z0-9.-]+):\d{2,5}([/?#]|$)/i.test(candidate)) {
    candidate = `${protocol}://${candidate}`;
  } else if (candidate.startsWith('/')) {
    const base = defaults.port ? `${protocol}://${host}:${defaults.port}` : `${protocol}://${host}`;
    candidate = `${base}${candidate}`;
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    // Bare hostname like `localhost:3000` handled above; this is e.g. `example.com`.
    candidate = `${candidate.includes('.') ? 'https://' : `${protocol}://${candidate}`}`;
    if (candidate.startsWith('https://') && !candidate.includes('://')) candidate = input;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    try {
      url = new URL(`${protocol}://${host}${input.startsWith('/') ? '' : ':5173'}${input.startsWith('/') ? input : `/${input}`}`);
    } catch (err) {
      throw new Error(`Could not interpret "${input}" as a URL or port. ${String(err)}`);
    }
  }
  return {
    url: url.toString(),
    origin: url.origin,
    host: url.host,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : null,
    protocol: url.protocol.replace(':', ''),
    path: `${url.pathname}${url.search}`,
  };
}
