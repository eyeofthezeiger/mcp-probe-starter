// Turns a snapshot into candidate call-registry entries, one per tool.
// Every candidate is status: unverified. Only the registry owner verifies.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse, stringify } from 'yaml';
import type { ServerConfig } from './config.ts';
import type { Change } from './diff.ts';
import type { Snapshot, ToolRecord } from './snapshot.ts';

export interface Candidate {
  id: string;
  path: string; // calls/<provider>/mcp/<id>.md
  data: Record<string, unknown>;
  text: string;
}

export interface CandidateRun {
  candidates: Candidate[];
  skipped: { server: string; tool?: string; reason: string }[];
}

const OPERATION = /^[A-Za-z0-9._-]+$/;
const VENDORED_SCHEMA = new URL('../vendor/call-registry/call.schema.json', import.meta.url);

function summaryOf(tool: ToolRecord): string {
  const text = (tool.description ?? tool.title ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return 'No description in tools/list.';
  const first = text.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? text;
  return first.length <= 200 ? first : `${first.slice(0, 197)}...`;
}

function paramsOf(tool: ToolRecord): Record<string, unknown> | undefined {
  const schema = (tool.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: unknown };
  const names = Object.keys(schema.properties ?? {});
  if (!names.length) return undefined;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === 'string')
    : [];
  const optional = names.filter((n) => !required.includes(n));
  const out: Record<string, unknown> = {};
  if (required.length) out.required = required;
  if (optional.length) out.optional = optional;
  return out;
}

// Header values keep their ${ENV} placeholders, so the snippet is safe to commit.
function genericConfig(server: ServerConfig): string {
  if (server.transport === 'streamable-http') {
    const entry: Record<string, unknown> = { type: 'http', url: server.url };
    if (server.headers && Object.keys(server.headers).length) entry.headers = server.headers;
    return `${JSON.stringify({ mcpServers: { [server.key]: entry } }, null, 2)}\n`;
  }
  const entry: Record<string, unknown> = { command: server.command, args: server.args ?? [] };
  if (server.env && Object.keys(server.env).length) entry.env = server.env;
  return `${JSON.stringify({ mcpServers: { [server.key]: entry } }, null, 2)}\n`;
}

function authHeader(server: ServerConfig): string | undefined {
  if (server.transport !== 'streamable-http') return undefined;
  const entry = Object.entries(server.headers ?? {}).find(([n]) => n.toLowerCase() === 'authorization');
  if (!entry) return undefined;
  return `${entry[0]}: ${entry[1].replace(/\$\{([A-Z0-9_]+)\}/g, '<$1>')}`;
}

function envVars(server: ServerConfig): string[] {
  const templates =
    server.transport === 'streamable-http' ? Object.values(server.headers ?? {}) : Object.values(server.env ?? {});
  const vars = new Set<string>();
  for (const t of templates) for (const m of t.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) vars.add(m[1]!);
  return [...vars].sort();
}

function describeChange(c: Change): string {
  const v = c.kind === 'removed' ? c.before : c.after;
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return `${c.kind} ${c.path}${text !== undefined ? ` = ${text.length > 120 ? `${text.slice(0, 117)}...` : text}` : ''}`;
}

export function buildCandidates(
  server: ServerConfig,
  snapshot: Snapshot,
  profileDiffs: { profile: string; changes: Change[] }[] = [],
): CandidateRun {
  const run: CandidateRun = { candidates: [], skipped: [] };
  const reg = server.registry;
  if (!reg) {
    run.skipped.push({ server: server.key, reason: 'no registry block in config (provider, auth_methods)' });
    return run;
  }
  const httpsUrl = server.transport === 'streamable-http' && server.url.startsWith('https://') ? server.url : undefined;
  const sourceUrl = httpsUrl ?? reg.source_url;
  if (!sourceUrl) {
    run.skipped.push({ server: server.key, reason: 'registry.source_url is needed for servers without an https URL' });
    return run;
  }
  const day = snapshot.probed_at.slice(0, 10);
  const serverVersion = (snapshot.initialize.serverInfo as { version?: string } | undefined)?.version;

  for (const tool of snapshot.tools) {
    if (!OPERATION.test(tool.name)) {
      run.skipped.push({
        server: server.key,
        tool: tool.name,
        reason: 'tool name has characters call-registry ids do not allow',
      });
      continue;
    }
    const id = `${reg.provider}.mcp.${tool.name}`;
    const readOnly = typeof tool.annotations?.readOnlyHint === 'boolean' ? tool.annotations.readOnlyHint : undefined;

    const notes: string[] = [
      `Candidate from mcp-probe, tools/list on ${day}, profile ${snapshot.profile}${serverVersion ? `, server version ${serverVersion}` : ''}.`,
    ];
    if (tool.annotations && Object.keys(tool.annotations).length)
      notes.push(`Annotations: ${JSON.stringify(tool.annotations)}.`);
    if (tool._meta && Object.keys(tool._meta).length) notes.push(`_meta: ${JSON.stringify(tool._meta)}.`);
    for (const pd of profileDiffs) {
      const mine = pd.changes.filter(
        (c) => c.path === `tools.${tool.name}` || c.path.startsWith(`tools.${tool.name}.`),
      );
      if (mine.length) notes.push(`With profile ${pd.profile}: ${mine.map(describeChange).join('; ')}.`);
    }

    const toolBlock: Record<string, unknown> = { name: tool.name, server: server.key };
    if (server.transport === 'streamable-http') toolBlock.server_url = server.url;
    toolBlock.transport = server.transport;
    if (reg.toolset) toolBlock.toolset = reg.toolset;
    if (readOnly !== undefined) toolBlock.read_only = readOnly;

    const auth: Record<string, unknown> = { methods: reg.auth_methods };
    const header = authHeader(server);
    if (header) auth.header = header;

    const data: Record<string, unknown> = {
      id,
      provider: reg.provider,
      ...(reg.product ? { product: reg.product } : {}),
      surface: 'mcp',
      operation: tool.name,
      summary: summaryOf(tool),
      tags: ['mcp-probe', ...(readOnly === true ? ['read'] : readOnly === false ? ['write'] : [])],
      tool: Object.fromEntries(Object.entries(toolBlock).filter(([, v]) => v !== undefined)),
      ...(paramsOf(tool) ? { params: paramsOf(tool) } : {}),
      auth,
      config: { generic: genericConfig(server) },
      source: { url: sourceUrl, read_on: day, kind: 'tools-list' },
      status: 'unverified',
      last_checked: day,
      notes: notes.join(' '),
      smoke: { kind: 'read', mcp_tools_list: true, ...(envVars(server).length ? { env: envVars(server) } : {}) },
      test: { status: 'untested' },
    };
    const body =
      'Generated by mcp-probe from what the server reported. Nothing here is verified.\n' +
      'Check it against the docs, merge it by hand, and leave fields out rather than guess.\n';
    run.candidates.push({
      id,
      path: join('calls', reg.provider, 'mcp', `${id}.md`),
      data,
      text: `---\n${stringify(data, { lineWidth: 0 })}---\n\n${body}`,
    });
  }
  return run;
}

export function loadSchema(registryDir?: string): object {
  const path = registryDir ? join(registryDir, 'schema', 'call.schema.json') : VENDORED_SCHEMA;
  return JSON.parse(readFileSync(path, 'utf8')) as object;
}

export function makeValidator(schema: object) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const validate = ajv.compile(schema);
  return (data: unknown): string[] =>
    validate(data) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim());
}

export interface MergeRow {
  id: string;
  path: string;
  state: 'new' | 'exists-same' | 'exists-differs';
  differs?: string[];
  schema_errors: string[];
}

// Never overwrites anything in the registry. Says which candidates are new
// and where existing entries disagree with what the server reported.
export function compareWithRegistry(
  candidates: Candidate[],
  registryDir: string | undefined,
  schema: object,
): MergeRow[] {
  const validate = makeValidator(schema);
  return candidates.map((c) => {
    const row: MergeRow = { id: c.id, path: c.path, state: 'new', schema_errors: validate(c.data) };
    if (!registryDir) return row;
    const file = join(registryDir, c.path);
    if (!existsSync(file)) return row;
    const m = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const existing = (m ? parse(m[1]!) : {}) as Record<string, unknown>;
    const differs: string[] = [];
    const existingTool = (existing.tool ?? {}) as Record<string, unknown>;
    const candTool = c.data.tool as Record<string, unknown>;
    for (const k of ['name', 'read_only']) {
      if (candTool[k] !== undefined && JSON.stringify(existingTool[k]) !== JSON.stringify(candTool[k]))
        differs.push(`tool.${k}`);
    }
    const ep = (existing.params ?? {}) as Record<string, unknown>;
    const cp = (c.data.params ?? {}) as Record<string, unknown>;
    for (const k of ['required', 'optional']) {
      const a = [...((ep[k] as string[] | undefined) ?? [])].sort();
      const b = [...((cp[k] as string[] | undefined) ?? [])].sort();
      if (JSON.stringify(a) !== JSON.stringify(b)) differs.push(`params.${k}`);
    }
    row.state = differs.length ? 'exists-differs' : 'exists-same';
    if (differs.length) row.differs = differs;
    return row;
  });
}

export function mergeReport(rows: MergeRow[], skipped: CandidateRun['skipped']): string {
  const lines = [
    '# call-registry candidates',
    '',
    'Everything here is unverified. Copy what you want into call-registry by hand, then run `npm run validate` there.',
    '',
  ];
  const group = (state: MergeRow['state'], title: string) => {
    const list = rows.filter((r) => r.state === state);
    if (!list.length) return;
    lines.push(`## ${title} (${list.length})`, '');
    for (const r of list) {
      const extra = r.differs ? ` (differs: ${r.differs.join(', ')})` : '';
      const bad = r.schema_errors.length ? ` SCHEMA: ${r.schema_errors.join('; ')}` : '';
      lines.push(`- \`${r.path}\`${extra}${bad}`);
    }
    lines.push('');
  };
  group('new', 'New');
  group('exists-differs', 'Already in the registry, but the server reports something different');
  group('exists-same', 'Already in the registry, no difference in tool, params or read_only');
  if (skipped.length) {
    lines.push(`## Skipped (${skipped.length})`, '');
    for (const s of skipped) lines.push(`- ${s.server}${s.tool ? ` / ${s.tool}` : ''}: ${s.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}
