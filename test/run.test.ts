import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProbe } from '../src/run.ts';
import { fakeConfig, fixedNow, inMemoryFactory, tempDir } from './helpers.ts';

describe('runProbe', () => {
  it('writes snapshots, a diff on the second run, profile diffs and registry candidates', async () => {
    const out = tempDir();
    const config = fakeConfig();

    const first = await runProbe(config, {
      outDir: out,
      transportFactory: inMemoryFactory().factory,
      now: fixedNow('2026-11-07T12:00:00Z'),
    });
    expect(first.runs.map((r) => [r.profile, r.status, r.changesSinceLast])).toEqual([
      ['plain', 'ok', undefined],
      ['mcp-apps', 'ok', undefined],
    ]);
    expect(existsSync(join(out, 'snapshots', 'fake', 'plain.json'))).toBe(true);
    expect(existsSync(join(out, 'diffs'))).toBe(false);
    expect(first.profileDiffs[0]?.changes.some((c) => c.path === 'tools.create_thing._meta')).toBe(true);
    expect(readdirSync(join(out, 'registry', 'calls', 'fake', 'mcp'))).toHaveLength(4);
    expect(readFileSync(join(out, 'registry', 'report.md'), 'utf8')).toContain('## New (4)');

    const second = await runProbe(config, {
      outDir: out,
      transportFactory: inMemoryFactory({ extraTool: true, version: '1.1.0' }).factory,
      now: fixedNow('2026-11-08T12:00:00Z'),
    });
    const plain = second.runs.find((r) => r.profile === 'plain')!;
    expect(plain.changesSinceLast).toBeGreaterThan(0);
    const diff = readFileSync(join(out, 'diffs', 'fake', 'plain.2026-11-08T12-00-00Z.md'), 'utf8');
    expect(diff).toContain('added `tools.new_tool`');
    expect(diff).toContain('changed `initialize.serverInfo.version`: 1.0.0 -> 1.1.0');
    expect(readdirSync(join(out, 'snapshots', 'fake', 'history'))).toHaveLength(4);
    expect(readdirSync(join(out, 'registry', 'calls', 'fake', 'mcp'))).toHaveLength(5);
    expect(readFileSync(join(out, 'runs', '2026-11-08T12-00-00Z.md'), 'utf8')).toContain('fake: plain vs mcp-apps');
  });

  it('runs only the servers asked for', async () => {
    const summary = await runProbe(fakeConfig(), {
      outDir: tempDir(),
      only: ['other'],
      transportFactory: inMemoryFactory().factory,
    });
    expect(summary.runs).toEqual([]);
  });
});
