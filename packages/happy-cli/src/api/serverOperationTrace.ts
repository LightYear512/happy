import axios, { type InternalAxiosRequestConfig } from 'axios';
import type { Socket } from 'socket.io-client';
import { configuration } from '@/configuration';
import { diagnosticTrace } from '@/ui/logger';

type TraceRecord = Record<string, unknown>;

const tracedSockets = new WeakSet<object>();
const tracedEngines = new WeakSet<object>();
const httpStartedAt = new WeakMap<object, number>();
let httpTraceInstalled = false;

function trace(record: TraceRecord): void {
    diagnosticTrace('[SERVER_IO]', JSON.stringify({ time: new Date().getTime(), ...record }));
}

function boundedReason(value: unknown): string {
    const raw = value instanceof Error ? value.message : String(value ?? 'unknown');
    return raw.length <= 256 ? raw : `${raw.slice(0, 256)}…`;
}

function wireBytes(value: unknown): number | null {
    if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
    if (Buffer.isBuffer(value)) return value.byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    return null;
}

function socketOperation(packet: { type?: unknown; data?: unknown }): string {
    const packetType = typeof packet.type === 'string' ? packet.type : 'unknown';
    if (packetType !== 'message' || typeof packet.data !== 'string') return packetType;
    const prefix = packet.data.slice(0, 512);
    const event = prefix.match(/\[\s*"([^"\\]{1,128})"/u)?.[1];
    if (event) return `event:${event}`;
    if (/^0/u.test(prefix)) return 'socket-connect';
    if (/^[36]/u.test(prefix)) return 'socket-ack';
    return 'message';
}

function attachEngineTrace(engine: any, scope: string): void {
    if (!engine || typeof engine !== 'object' || tracedEngines.has(engine)) return;
    tracedEngines.add(engine);
    engine.on?.('packetCreate', (packet: { type?: unknown; data?: unknown }) => {
        trace({ transport: 'socket', scope, phase: 'packet', direction: 'out',
            operation: socketOperation(packet), payloadBytes: wireBytes(packet.data) });
    });
    engine.on?.('packet', (packet: { type?: unknown; data?: unknown }) => {
        trace({ transport: 'socket', scope, phase: 'packet', direction: 'in',
            operation: socketOperation(packet), payloadBytes: wireBytes(packet.data) });
    });
    engine.on?.('upgrade', (transport: { name?: unknown }) => {
        trace({ transport: 'socket', scope, phase: 'transport-upgrade',
            operation: typeof transport?.name === 'string' ? transport.name : 'unknown' });
    });
}

/** Adds passive, payload-free tracing to one Happy-server Socket.IO connection. */
export function traceHappyServerSocket(socket: Socket, scope: string): void {
    if (tracedSockets.has(socket)) return;
    tracedSockets.add(socket);
    const manager = socket.io as any;
    trace({ transport: 'socket', scope, phase: 'created' });
    attachEngineTrace(manager?.engine, scope);
    manager?.on?.('open', () => attachEngineTrace(manager.engine, scope));
    manager?.on?.('reconnect_attempt', (attempt: number) => {
        trace({ transport: 'socket', scope, phase: 'reconnect-attempt', attempt });
    });
    manager?.on?.('reconnect', (attempt: number) => {
        trace({ transport: 'socket', scope, phase: 'reconnected', attempt });
        attachEngineTrace(manager.engine, scope);
    });
    manager?.on?.('reconnect_failed', () => {
        trace({ transport: 'socket', scope, phase: 'reconnect-failed' });
    });
    socket.on('connect', () => {
        trace({ transport: 'socket', scope, phase: 'connected', socketId: socket.id ?? null,
            connectionRecovered: socket.recovered === true });
        attachEngineTrace(manager?.engine, scope);
    });
    socket.on('disconnect', (reason) => {
        trace({ transport: 'socket', scope, phase: 'disconnected', reason: boundedReason(reason) });
    });
    socket.on('connect_error', (error) => {
        trace({ transport: 'socket', scope, phase: 'connect-error', reason: boundedReason(error) });
    });
}

function happyHttpRequest(config: InternalAxiosRequestConfig): { method: string; path: string } | null {
    try {
        const url = new URL(config.url ?? '', config.baseURL ?? configuration.serverUrl);
        const server = new URL(configuration.serverUrl);
        if (url.origin !== server.origin) return null;
        return { method: (config.method ?? 'get').toUpperCase(), path: url.pathname };
    } catch {
        return null;
    }
}

function headerBytes(headers: unknown): number | null {
    if (!headers || typeof headers !== 'object') return null;
    const candidate = headers as { get?: (name: string) => unknown; [key: string]: unknown };
    const raw = candidate.get?.('content-length') ?? candidate['content-length'] ?? candidate['Content-Length'];
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Installs one process-wide, passive Axios trace for Happy-server HTTP calls. */
export function installHappyServerHttpTrace(): void {
    if (httpTraceInstalled) return;
    httpTraceInstalled = true;
    axios.interceptors.request.use((config) => {
        const request = happyHttpRequest(config);
        if (!request) return config;
        httpStartedAt.set(config, performance.now());
        trace({ transport: 'http', phase: 'started', ...request,
            requestBytes: headerBytes(config.headers) });
        return config;
    });
    axios.interceptors.response.use((response) => {
        const request = happyHttpRequest(response.config);
        if (request) {
            const startedAt = httpStartedAt.get(response.config);
            trace({ transport: 'http', phase: 'completed', ...request, status: response.status,
                durationMs: startedAt === undefined ? null : Math.round(performance.now() - startedAt),
                responseBytes: headerBytes(response.headers) });
        }
        return response;
    }, (error: unknown) => {
        const config = axios.isAxiosError(error) ? error.config : undefined;
        const request = config ? happyHttpRequest(config) : null;
        if (request && config) {
            const startedAt = httpStartedAt.get(config);
            trace({ transport: 'http', phase: 'failed', ...request,
                status: axios.isAxiosError(error) ? error.response?.status ?? null : null,
                durationMs: startedAt === undefined ? null : Math.round(performance.now() - startedAt),
                reason: boundedReason(error) });
        }
        return Promise.reject(error);
    });
}
