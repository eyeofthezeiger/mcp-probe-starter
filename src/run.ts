// Runs every configured server under every profile, writes snapshots, diffs
// against the last run, compares profiles and writes registry candidates.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { profilesFor, type ProbeConfig } from './config.ts';
import { changesToMarkdown, diffSnapshots, type Change } from './diff.ts';
import { probeServer, type ProbeOptions, type ProbeResult } from './probe.ts';
import { buildCandidates, compareWithRegistry, loadSchema, mergeReport, type MergeRow } from './registry.ts';
import type { Snapshot } from './snapshot.ts';

export interface RunOptions extends ProbeOptions {
  only?: string[];
  outDir?: string;
  registryDir?: string;
}

export interface ServerRun {
  server: string;
  profile: string;
  status: ProbeResult['status'];
  reason?: string;
  tools?: number;
  hints?: number;
  changesSinceLast?: number;
}

export interface RunSummary {
  stamp: string;
  outDir: string;
  runs: ServerRun[];
  profileDiffs: { server: string; base: string; profile: string; changes: Change[] }[];
  registry: MergeRow[];
  files: string[];
}

function write(path: string, text: string, files: string[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
  files.push(path);
}

function json(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

export async function runProbe(config: ProbeConfig, options: RunOptions = {}): Promise<RunSummary> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const stamp = startedAt
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-');
  const outDir = resolve(options.outDir ?? config.output_dir);
  const summary: RunSummary = { stamp, outDir, runs: [], profileDiffs: [], registry: [], files: [] };
  const schema = loadSchema(options.registryDir);
  const allCandidates = [];
  const allSkipped = [];

  const servers = config.servers.filter(
    (s) => s.enabled !== false && (!options.only?.length || options.only.includes(s.key)),
  );

  for (const server of servers) {
    const snapshots = new Map<string, Snapshot>();
    for (const profile of profilesFor(config, server)) {
      const result = await probeServer(config, server, profile, { ...options, now });
      if (result.status !== 'ok') {
        summary.runs.push({ server: server.key, profile, status: result.status, reason: result.reason });
        continue;
      }
      const snap = result.snapshot;
      snapshots.set(profile, snap);
      const latest = join(outDir, 'snapshots', server.key, `${profile}.json`);
      let changes: Change[] | undefined;
      if (existsSync(latest)) {
        const previous = JSON.parse(readFileSync(latest, 'utf8')) as Snapshot;
        changes = diffSnapshots(previous, snap);
        const base = join(outDir, 'diffs', server.key, `${profile}.${stamp}`);
        write(`${base}.json`, json({ from: previous.probed_at, to: snap.probed_at, changes }), summary.files);
        write(
          `${base}.md`,
          changesToMarkdown(`${server.key} / ${profile}: ${previous.probed_at} -> ${snap.probed_at}`, changes),
          summary.files,
        );
      }
      write(latest, json(snap), summary.files);
      write(join(outDir, 'snapshots', server.key, 'history', `${profile}.${stamp}.json`), json(snap), summary.files);
      summary.runs.push({
        server: server.key,
        profile,
        status: 'ok',
        tools: snap.tools.length,
        hints: snap.hints.length,
        changesSinceLast: changes?.length,
      });
    }

    // Same server, different client: what changes when we advertise more?
    const [baseName, ...others] = [...snapshots.keys()];
    const serverProfileDiffs: { profile: string; changes: Change[] }[] = [];
    if (baseName) {
      const base = snapshots.get(baseName)!;
      const md: string[] = [];
      for (const other of others) {
        const changes = diffSnapshots(base, snapshots.get(other)!).filter(
          (c) => !c.path.startsWith('request.') && c.path !== 'request',
        );
        summary.profileDiffs.push({ server: server.key, base: baseName, profile: other, changes });
        serverProfileDiffs.push({ profile: other, changes });
        md.push(changesToMarkdown(`${server.key}: ${baseName} vs ${other}`, changes));
      }
      if (md.length) write(join(outDir, 'profiles', `${server.key}.${stamp}.md`), md.join('\n'), summary.files);

      const built = buildCandidates(server, base, serverProfileDiffs);
      allCandidates.push(...built.candidates);
      allSkipped.push(...built.skipped);
    }
  }

  const registryOut = join(outDir, 'registry');
  rmSync(join(registryOut, 'calls'), { recursive: true, force: true });
  for (const c of allCandidates) write(join(registryOut, c.path), c.text, summary.files);
  summary.registry = compareWithRegistry(allCandidates, options.registryDir, schema);
  write(join(registryOut, 'report.md'), mergeReport(summary.registry, allSkipped), summary.files);
  write(join(outDir, 'runs', `${stamp}.md`), runMarkdown(summary), summary.files);
  return summary;
}

export function runMarkdown(s: RunSummary): string {
  const lines = [`# mcp-probe run ${s.stamp}`, ''];
  for (const r of s.runs) {
    if (r.status === 'ok') {
      const since =
        r.changesSinceLast === undefined ? 'first snapshot' : `${r.changesSinceLast} change(s) since last run`;
      lines.push(`- ${r.server} / ${r.profile}: ok, ${r.tools} tool(s), ${r.hints} hint(s), ${since}`);
    } else {
      lines.push(`- ${r.server} / ${r.profile}: ${r.status}, ${r.reason}`);
    }
  }
  if (s.profileDiffs.length) {
    lines.push('', 'Profile differences:');
    for (const d of s.profileDiffs)
      lines.push(`- ${d.server}: ${d.base} vs ${d.profile}, ${d.changes.length} difference(s)`);
  }
  const fresh = s.registry.filter((r) => r.state === 'new').length;
  const differs = s.registry.filter((r) => r.state === 'exists-differs').length;
  const bad = s.registry.filter((r) => r.schema_errors.length).length;
  lines.push(
    '',
    `Registry candidates: ${s.registry.length} (${fresh} new, ${differs} differ from the registry, ${bad} fail the schema).`,
    '',
  );
  return lines.join('\n');
}
