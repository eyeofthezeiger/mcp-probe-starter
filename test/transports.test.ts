// Real transports: streamable HTTP on localhost and stdio with a child process.
import { createServer, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.ts';
import { probeServer } from '../src/probe.ts';
import { createFakeServer } from './fixtures/fake-server.ts';

const SECRET = 'super-secret-token-value-123';

describe('streamable HTTP', () => {
  let http: HttpServer;
  let url = '';
  const seen: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    http = createServer(async (req, res) => {
      seen.push(req.headers);
      // Stateless: a fresh server per request. Leaks the auth header back.
      const { server } = createFakeServer({ leak: String(req.headers.authorization ?? '') });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.setHeader('X-Acme-Mode', 'beta');
      res.on('close', () => void transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => new Promise<void>((r) => http.close(() => r())));

  const config = () =>
    parseConfig({
      profiles: { flags: { headers: { 'X-Acme-Features': 'beta-forms' } } },
      servers: [
        {
          key: 'local',
          transport: 'streamable-http',
          url,
          headers: { Authorization: 'Bearer ${FAKE_TOKEN}' },
          profiles: ['flags'],
        },
      ],
    });

  it('sends env-sourced and feature headers, and scrubs the secret from the snapshot', async () => {
    const c = config();
    const result = await probeServer(c, c.servers[0]!, 'flags', { env: { FAKE_TOKEN: SECRET } });
    if (result.status !== 'ok') throw new Error(result.reason);
    const snap = result.snapshot;
    expect(seen.at(-1)?.authorization).toBe(`Bearer ${SECRET}`);
    expect(seen.at(-1)?.['x-acme-features']).toBe('beta-forms');
    expect(snap.request.headers).toEqual({ Authorization: 'Bearer [env FAKE_TOKEN]', 'X-Acme-Features': 'beta-forms' });
    expect(snap.response_headers['x-acme-mode']).toBe('beta');
    expect(snap.hints.some((h) => h.kind === 'response-header' && h.where === 'response_headers.x-acme-mode')).toBe(
      true,
    );
    expect(snap.tools).toHaveLength(4);
    const text = JSON.stringify(snap);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('[redacted env FAKE_TOKEN]');
  });

  it('skips a server whose env vars are missing, without connecting', async () => {
    const before = seen.length;
    const c = config();
    const result = await probeServer(c, c.servers[0]!, 'flags', { env: {} });
    expect(result).toEqual({ status: 'skipped', server: 'local', profile: 'flags', reason: 'missing env FAKE_TOKEN' });
    expect(seen.length).toBe(before);
  });
});

describe('stdio', () => {
  it('spawns the server, captures stderr config lines and scrubs env secrets', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/stdio-server.ts', import.meta.url));
    const c = parseConfig({
      servers: [
        {
          key: 'child',
          transport: 'stdio',
          command: process.execPath,
          args: [fixture],
          env: { FAKE_STDIO_TOKEN: '${FAKE_STDIO_TOKEN}' },
        },
      ],
    });
    const result = await probeServer(c, c.servers[0]!, 'plain', { env: { FAKE_STDIO_TOKEN: SECRET } });
    if (result.status !== 'ok') throw new Error(result.reason);
    expect(result.snapshot.tools).toHaveLength(4);
    expect(result.snapshot.hints).toContainEqual({
      kind: 'stderr-config',
      where: 'stderr',
      detail: 'toolsets enabled: things,prompts',
    });
    expect(JSON.stringify(result.snapshot)).not.toContain(SECRET);
  });
});
