import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.ts';
import { diffSnapshots } from '../src/diff.ts';
import { probeServer } from '../src/probe.ts';
import { buildCandidates, compareWithRegistry, loadSchema, makeValidator, mergeReport } from '../src/registry.ts';
import { fakeConfig, fixedNow, inMemoryFactory, tempDir } from './helpers.ts';

async function snapshots() {
  const config = fakeConfig();
  const server = config.servers[0]!;
  const out: Record<string, Awaited<ReturnType<typeof probeServer>>> = {};
  for (const p of ['plain', 'mcp-apps']) {
    out[p] = await probeServer(config, server, p, {
      transportFactory: inMemoryFactory().factory,
      now: fixedNow('2026-11-07T12:00:00Z'),
    });
  }
  if (out.plain?.status !== 'ok' || out['mcp-apps']?.status !== 'ok') throw new Error('probe failed');
  return { server, plain: out.plain.snapshot, apps: out['mcp-apps'].snapshot };
}

describe('buildCandidates', () => {
  it('writes one unverified, schema-valid entry per tool', async () => {
    const { server, plain } = await snapshots();
    const run = buildCandidates(server, plain);
    const validate = makeValidator(loadSchema());
    expect(run.candidates.map((c) => c.id)).toEqual([
      'fake.mcp.create_thing',
      'fake.mcp.delete_thing',
      'fake.mcp.get_thing',
      'fake.mcp.mystery',
    ]);
    for (const c of run.candidates) {
      expect(validate(c.data)).toEqual([]);
      expect(c.data.status).toBe('unverified');
      expect(c.data).not.toHaveProperty('verified_by');
      expect(c.path).toBe(join('calls', 'fake', 'mcp', `${c.id}.md`));
      expect(c.text.startsWith('---\n')).toBe(true);
    }
    const get = run.candidates.find((c) => c.id === 'fake.mcp.get_thing')!.data;
    expect(get.tool).toEqual({
      name: 'get_thing',
      server: 'fake',
      server_url: 'https://fake.example.com/mcp',
      transport: 'streamable-http',
      read_only: true,
    });
    expect(get.params).toEqual({ required: ['id'] });
    expect(get.source).toEqual({ url: 'https://fake.example.com/mcp', read_on: '2026-11-07', kind: 'tools-list' });
    expect(get.smoke).toEqual({ kind: 'read', mcp_tools_list: true });
  });

  it('notes what changes under other client profiles', async () => {
    const { server, plain, apps } = await snapshots();
    const run = buildCandidates(server, plain, [{ profile: 'mcp-apps', changes: diffSnapshots(plain, apps) }]);
    const create = run.candidates.find((c) => c.id === 'fake.mcp.create_thing')!;
    expect(create.data.notes).toContain('With profile mcp-apps: added tools.create_thing._meta');
    expect(create.data.notes).toContain('ui://fake/create-form');
  });

  it('skips servers without a registry block or a citable source', async () => {
    const { plain } = await snapshots();
    const noRegistry = parseConfig({
      servers: [{ key: 'fake', transport: 'streamable-http', url: 'https://x.example/mcp' }],
    });
    expect(buildCandidates(noRegistry.servers[0]!, plain).skipped[0]?.reason).toMatch(/no registry block/);
    const stdio = parseConfig({
      servers: [
        { key: 'fake', transport: 'stdio', command: 'x', registry: { provider: 'fake', auth_methods: ['none'] } },
      ],
    });
    expect(buildCandidates(stdio.servers[0]!, plain).skipped[0]?.reason).toMatch(/source_url/);
  });
});

describe('compareWithRegistry', () => {
  it('marks new and existing entries and never needs to write to the registry', async () => {
    const { server, plain } = await snapshots();
    const { candidates, skipped } = buildCandidates(server, plain);
    const dir = tempDir();
    mkdirSync(join(dir, 'calls', 'fake', 'mcp'), { recursive: true });
    writeFileSync(
      join(dir, 'calls', 'fake', 'mcp', 'fake.mcp.get_thing.md'),
      '---\nid: fake.mcp.get_thing\ntool: { name: get_thing, server: fake, read_only: true }\nparams: { required: [id, extra] }\n---\n',
    );
    writeFileSync(
      join(dir, 'calls', 'fake', 'mcp', 'fake.mcp.create_thing.md'),
      '---\nid: fake.mcp.create_thing\ntool: { name: create_thing, server: fake, read_only: false }\nparams: { required: [name], optional: [draft] }\n---\n',
    );
    const rows = compareWithRegistry(candidates, dir, loadSchema());
    const state = Object.fromEntries(rows.map((r) => [r.id, r.state]));
    expect(state).toEqual({
      'fake.mcp.create_thing': 'exists-same',
      'fake.mcp.delete_thing': 'new',
      'fake.mcp.get_thing': 'exists-differs',
      'fake.mcp.mystery': 'new',
    });
    expect(rows.find((r) => r.id === 'fake.mcp.get_thing')?.differs).toEqual(['params.required']);
    expect(mergeReport(rows, skipped)).toContain('## New (2)');
  });
});
