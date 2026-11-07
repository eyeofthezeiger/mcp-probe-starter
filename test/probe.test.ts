import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '../src/diff.ts';
import { probeServer, readOnlyRefusal } from '../src/probe.ts';
import type { Snapshot } from '../src/snapshot.ts';
import { fakeConfig, fixedNow, inMemoryFactory } from './helpers.ts';

async function probe(profile: string, opts: { callReadOnly?: boolean } = {}) {
  const config = fakeConfig();
  const { factory, calls } = inMemoryFactory();
  const result = await probeServer(config, config.servers[0]!, profile, {
    transportFactory: factory,
    now: fixedNow('2026-11-07T12:00:00Z'),
    ...opts,
  });
  if (result.status !== 'ok') throw new Error(`probe failed: ${result.reason}`);
  return { snap: result.snapshot, calls };
}

describe('probeServer', () => {
  it('records server info, capabilities and every list, across pages', async () => {
    const { snap } = await probe('plain');
    expect(snap.initialize.serverInfo).toEqual({ name: 'fake-server', version: '1.0.0' });
    expect((snap.initialize.capabilities as Record<string, unknown>).experimental).toEqual({
      'acme/flags': { available: ['beta-forms'] },
    });
    expect(snap.tools.map((t) => t.name)).toEqual(['create_thing', 'delete_thing', 'get_thing', 'mystery']);
    expect(snap.tools.find((t) => t.name === 'get_thing')?.outputSchema).toBeDefined();
    expect(snap.resources).toHaveLength(1);
    expect(snap.prompts).toHaveLength(1);
    // The fake has no templates handler: the error is recorded, not thrown.
    expect(snap.errors['resources/templates/list']).toMatch(/not found/i);
  });

  it('keeps fields outside the spec that the SDK would not model', async () => {
    const { snap } = await probe('plain');
    expect(snap.tools.find((t) => t.name === 'mystery')?.['x-acme-scope']).toBe('repo');
  });

  it('turns odd findings into hints', async () => {
    const { snap } = await probe('plain');
    const kinds = new Set(snap.hints.map((h) => h.kind));
    expect(kinds).toContain('capability-experimental');
    expect(kinds).toContain('tool-extra');
    expect(kinds).toContain('annotations-missing');
    expect(kinds).toContain('ui-resource');
    expect(kinds).toContain('tool-destructive');
    expect(snap.hints.some((h) => h.kind === 'instructions-knob' && h.detail.includes('X-Acme-Features'))).toBe(true);
    expect(snap.hints.some((h) => h.kind === 'description-knob' && h.where === 'tools.get_thing.description')).toBe(
      true,
    );
  });

  it('shows config that only appears for some clients', async () => {
    const plain = (await probe('plain')).snap;
    const apps = (await probe('mcp-apps')).snap;
    const changes = diffSnapshots(plain, apps).filter((c) => !c.path.startsWith('request'));
    expect(changes).toContainEqual(
      expect.objectContaining({
        path: 'tools.create_thing._meta',
        kind: 'added',
        after: { ui: { resourceUri: 'ui://fake/create-form' } },
      }),
    );
    expect(apps.hints.some((h) => h.kind === 'tool-meta' && h.where === 'tools[*]._meta.ui')).toBe(true);
  });

  it('never calls a tool by default', async () => {
    const { snap, calls } = await probe('plain');
    expect(calls).toEqual([]);
    expect(snap.read_only_calls).toEqual([]);
  });

  it('with read-only calls on, calls only tools marked readOnlyHint true and stores shape only', async () => {
    const { snap, calls } = await probe('plain', { callReadOnly: true });
    expect(calls).toEqual(['get_thing']);
    const byTool = Object.fromEntries(snap.read_only_calls.map((c) => [c.tool, c]));
    expect(byTool.get_thing?.outcome).toBe('called');
    expect(byTool.get_thing?.shape).toEqual({
      isError: undefined,
      result_keys: ['content', 'structuredContent'],
      content_types: ['text'],
      structured_keys: ['id', 'name'],
      meta_keys: [],
    });
    expect(byTool.create_thing?.outcome).toBe('refused');
    expect(byTool.delete_thing?.outcome).toBe('refused');
    expect(JSON.stringify(snap)).not.toContain('private data');
    expect(JSON.stringify(snap)).not.toContain('private name');
  });
});

describe('readOnlyRefusal', () => {
  const tool = (annotations?: Record<string, unknown>) => ({ name: 't', annotations }) as Snapshot['tools'][number];
  it('allows only readOnlyHint true and not destructive', () => {
    expect(readOnlyRefusal(tool({ readOnlyHint: true }))).toBeUndefined();
    expect(readOnlyRefusal(tool({ readOnlyHint: true, destructiveHint: true }))).toMatch(/destructive/);
    expect(readOnlyRefusal(tool({ readOnlyHint: false }))).toMatch(/readOnlyHint/);
    expect(readOnlyRefusal(tool())).toMatch(/readOnlyHint/);
    expect(readOnlyRefusal(tool({ readOnlyHint: 'true' }))).toMatch(/readOnlyHint/);
    expect(readOnlyRefusal(undefined)).toMatch(/not in tools\/list/);
  });
});
