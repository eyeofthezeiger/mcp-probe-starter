import { describe, expect, it } from 'vitest';
import { changesToMarkdown, deepDiff, diffSnapshots, toolsTouched } from '../src/diff.ts';
import { redact, redactHeaders } from '../src/redact.ts';
import { SNAPSHOT_VERSION, type Snapshot } from '../src/snapshot.ts';

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    snapshot_version: SNAPSHOT_VERSION,
    server: 's',
    profile: 'plain',
    probed_at: '2026-11-07T00:00:00.000Z',
    transport: 'streamable-http',
    target: 'https://example.com/mcp',
    request: { client: { name: 'c', version: '1' }, capabilities: {}, headers: {} },
    initialize: { serverInfo: { name: 's', version: '1' } },
    tools: [
      { name: 'a', inputSchema: { type: 'object' } },
      { name: 'b', inputSchema: { type: 'object' } },
    ],
    resources: [],
    resource_templates: [],
    prompts: [],
    list_extras: {},
    notifications: [],
    response_headers: { date: 'today' },
    errors: {},
    read_only_calls: [],
    hints: [],
    ...over,
  };
}

describe('diffSnapshots', () => {
  it('ignores order and volatile fields', () => {
    const a = snap();
    const b = snap({
      probed_at: '2026-11-08T00:00:00.000Z',
      tools: [...a.tools].reverse(),
      response_headers: { date: 'tomorrow' },
      stderr_head: 'noise',
    });
    expect(diffSnapshots(a, b)).toEqual([]);
  });

  it('reports added tools, changed versions and new _meta', () => {
    const a = snap();
    const b = snap({
      initialize: { serverInfo: { name: 's', version: '2' } },
      tools: [
        { name: 'a', inputSchema: { type: 'object' }, _meta: { 'ui/resourceUri': 'ui://x' } },
        a.tools[1]!,
        { name: 'c' },
      ],
    });
    const changes = diffSnapshots(a, b);
    expect(changes).toContainEqual({ path: 'initialize.serverInfo.version', kind: 'changed', before: '1', after: '2' });
    expect(changes).toContainEqual(expect.objectContaining({ path: 'tools.c', kind: 'added' }));
    expect(changes).toContainEqual(expect.objectContaining({ path: 'tools.a._meta', kind: 'added' }));
    expect([...toolsTouched(changes).keys()].sort()).toEqual(['a', 'c']);
    expect(changesToMarkdown('t', changes)).toContain('added `tools.c`');
  });

  it('quotes keys that are not plain identifiers', () => {
    expect(deepDiff({}, { 'io.modelcontextprotocol/ui': {} })).toEqual([
      { path: '"io.modelcontextprotocol/ui"', kind: 'added', after: {} },
    ]);
  });
});

describe('redact', () => {
  it('scrubs known values and common token shapes', () => {
    const secrets = new Map([['my-exact-secret', 'TOKEN']]);
    const out = redact(
      { a: 'x my-exact-secret y', b: ['ghp_abcdefghijklmnopqrstuvwxyz1234'], c: 'Bearer abcdefghijklmnop' },
      secrets,
    );
    expect(out).toEqual({ a: 'x [redacted env TOKEN] y', b: ['[redacted token]'], c: '[redacted token]' });
  });

  it('hides sensitive response headers', () => {
    expect(redactHeaders({ 'Set-Cookie': 'a=b', 'Mcp-Session-Id': 'abc', 'X-Thing': '1' })).toEqual({
      'set-cookie': '[redacted]',
      'mcp-session-id': '[redacted]',
      'x-thing': '1',
    });
  });
});
