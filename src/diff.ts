// Compares two snapshots: the same server over time, or the same server under
// two client profiles. Lists become maps keyed by name or URI so a reorder
// isn't a change.
import { VOLATILE_KEYS, VOLATILE_RESPONSE_HEADERS, type Snapshot } from './snapshot.ts';

export interface Change {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

function keyed(items: Record<string, unknown>[], key: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of items) out[String(item[key])] = item;
  return out;
}

export function comparable(s: Snapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (VOLATILE_KEYS.has(k) || k === 'server' || k === 'profile' || k === 'snapshot_version') continue;
    out[k] = v;
  }
  out.tools = keyed(s.tools, 'name');
  out.resources = keyed(s.resources, 'uri');
  out.resource_templates = keyed(s.resource_templates, 'uriTemplate');
  out.prompts = keyed(s.prompts, 'name');
  out.read_only_calls = keyed(s.read_only_calls as unknown as Record<string, unknown>[], 'tool');
  out.hints = [...new Set(s.hints.map((h) => `${h.kind} ${h.where}: ${h.detail}`))].sort();
  out.response_headers = Object.fromEntries(
    Object.entries(s.response_headers).filter(([name]) => !VOLATILE_RESPONSE_HEADERS.has(name)),
  );
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const SEGMENT = /^[A-Za-z_$][\w$-]*$/;
function join(path: string, key: string): string {
  const seg = SEGMENT.test(key) ? key : JSON.stringify(key);
  return path ? `${path}.${seg}` : seg;
}

export function deepDiff(a: unknown, b: unknown, path = ''): Change[] {
  if (equal(a, b)) return [];
  if (isPlainObject(a) && isPlainObject(b)) {
    const changes: Change[] = [];
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const p = join(path, k);
      if (!(k in a)) changes.push({ path: p, kind: 'added', after: b[k] });
      else if (!(k in b)) changes.push({ path: p, kind: 'removed', before: a[k] });
      else changes.push(...deepDiff(a[k], b[k], p));
    }
    return changes;
  }
  if (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.every((x) => typeof x === 'string') &&
    b.every((x) => typeof x === 'string')
  ) {
    const changes: Change[] = [];
    for (const x of b) if (!a.includes(x)) changes.push({ path: `${path}[]`, kind: 'added', after: x });
    for (const x of a) if (!b.includes(x)) changes.push({ path: `${path}[]`, kind: 'removed', before: x });
    return changes;
  }
  return [{ path: path || '(root)', kind: 'changed', before: a, after: b }];
}

export function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
  return deepDiff(comparable(before), comparable(after));
}

function short(v: unknown): string {
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export function changesToMarkdown(title: string, changes: Change[]): string {
  const lines = [`# ${title}`, ''];
  if (!changes.length) return [...lines, 'No changes.', ''].join('\n');
  lines.push(`${changes.length} change(s).`, '');
  for (const c of changes) {
    if (c.kind === 'added') lines.push(`- added \`${c.path}\`: ${short(c.after)}`);
    else if (c.kind === 'removed') lines.push(`- removed \`${c.path}\`: ${short(c.before)}`);
    else lines.push(`- changed \`${c.path}\`: ${short(c.before)} -> ${short(c.after)}`);
  }
  return [...lines, ''].join('\n');
}

// Which tools a set of changes touches, for notes on registry candidates.
export function toolsTouched(changes: Change[]): Map<string, Change[]> {
  const out = new Map<string, Change[]>();
  for (const c of changes) {
    const m = c.path.match(/^tools\.("(?:[^"\\]|\\.)*"|[^.]+)/);
    if (!m) continue;
    const name = m[1]!.startsWith('"') ? (JSON.parse(m[1]!) as string) : m[1]!;
    out.set(name, [...(out.get(name) ?? []), c]);
  }
  return out;
}
