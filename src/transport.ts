// Builds the client transport for a server and wraps it so we keep the raw
// JSON-RPC results. The SDK validates and can drop fields it doesn't know;
// unknown fields are exactly the undocumented config we're after.
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import { expand, type ProfileConfig, type ServerConfig } from './config.ts';

export interface RawExchange {
  method: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export class RecordingTransport implements Transport {
  readonly exchanges: RawExchange[] = [];
  readonly notifications: { method: string; params?: unknown }[] = [];
  private pending = new Map<string | number, RawExchange>();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  private readonly inner: Transport;

  constructor(inner: Transport) {
    this.inner = inner;
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (e) => this.onerror?.(e);
    this.inner.onmessage = (message, extra) => {
      this.record(message);
      this.onmessage?.(message, extra);
    };
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const m = message as { id?: string | number; method?: string; params?: unknown };
    if (m.method !== undefined && m.id !== undefined) {
      const ex: RawExchange = { method: m.method, params: m.params };
      this.pending.set(m.id, ex);
      this.exchanges.push(ex);
    }
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  private record(message: JSONRPCMessage) {
    const m = message as {
      id?: string | number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    if (m.id !== undefined && m.method === undefined) {
      const ex = this.pending.get(m.id);
      if (!ex) return;
      this.pending.delete(m.id);
      if ('result' in m) ex.result = structuredClone(m.result);
      if (m.error) ex.error = { code: m.error.code, message: m.error.message };
    } else if (m.method !== undefined && m.id === undefined) {
      this.notifications.push({ method: m.method, params: m.params });
    }
  }

  results(method: string): RawExchange[] {
    return this.exchanges.filter((e) => e.method === method);
  }
}

export interface BuiltTransport {
  transport: Transport;
  // Header values as we describe them in snapshots: env-sourced values are
  // shown as [env NAME], literal values as-is.
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  stderr: () => string;
  envUsed: string[];
  missing: string[];
  secrets: Map<string, string>;
  target: string;
}

function describeHeaders(templates: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, t] of Object.entries(templates)) {
    out[name] = t.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_m, v: string) => `[env ${v}]`);
  }
  return out;
}

const STDERR_LIMIT = 8_000;

export function buildTransport(
  server: ServerConfig,
  profile: ProfileConfig,
  env: NodeJS.ProcessEnv = process.env,
): BuiltTransport {
  if (server.transport === 'streamable-http') {
    const templates = { ...(server.headers ?? {}), ...(profile.headers ?? {}) };
    const filled = expand(templates, env);
    const responseHeaders: Record<string, string> = {};
    let captured = false;
    const recordingFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!captured) {
        captured = true;
        res.headers.forEach((value, name) => {
          responseHeaders[name] = value;
        });
      }
      return res;
    };
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: filled.values },
      fetch: recordingFetch,
    });
    return {
      transport,
      requestHeaders: describeHeaders(templates),
      responseHeaders,
      stderr: () => '',
      envUsed: filled.envUsed,
      missing: filled.missing,
      secrets: filled.secrets,
      target: server.url,
    };
  }

  const filled = expand(server.env, env);
  let stderrText = '';
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: { ...getDefaultEnvironment(), ...filled.values },
    cwd: server.cwd,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    if (stderrText.length < STDERR_LIMIT) stderrText += chunk.toString('utf8');
  });
  return {
    transport,
    requestHeaders: {},
    responseHeaders: {},
    stderr: () => stderrText.slice(0, STDERR_LIMIT),
    envUsed: filled.envUsed,
    missing: filled.missing,
    secrets: filled.secrets,
    target: [server.command, ...(server.args ?? [])].join(' '),
  };
}
