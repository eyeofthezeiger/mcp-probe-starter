import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseConfig, type ProbeConfig } from '../src/config.ts';
import type { BuiltTransport } from '../src/transport.ts';
import { createFakeServer, UI_EXTENSION, type FakeOptions } from './fixtures/fake-server.ts';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-probe-'));
}

export function fakeConfig(extra: Record<string, unknown> = {}): ProbeConfig {
  return parseConfig({
    profiles: {
      plain: {},
      'mcp-apps': { capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: ['text/html;profile=mcp-app'] } } } },
    },
    default_profiles: ['plain', 'mcp-apps'],
    servers: [
      {
        key: 'fake',
        transport: 'streamable-http',
        url: 'https://fake.example.com/mcp',
        registry: { provider: 'fake', auth_methods: ['none'] },
        read_only_calls: [
          { tool: 'get_thing', arguments: { id: '1' } },
          { tool: 'create_thing', arguments: { name: 'x' } },
          { tool: 'delete_thing', arguments: { id: '1' } },
        ],
      },
    ],
    ...extra,
  });
}

// In-process transport factory. Each probe gets a fresh fake server.
export function inMemoryFactory(options: FakeOptions = {}) {
  const calls: string[] = [];
  const factory = (): BuiltTransport => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const fake = createFakeServer({ ...options, calls });
    void fake.server.connect(serverSide);
    return {
      transport: clientSide,
      requestHeaders: {},
      responseHeaders: {},
      stderr: () => '',
      envUsed: [],
      missing: [],
      secrets: new Map(),
      target: 'in-memory',
    };
  };
  return { factory, calls };
}

export const fixedNow = (iso: string) => () => new Date(iso);
