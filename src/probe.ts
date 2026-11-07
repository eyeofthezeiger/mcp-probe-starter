// Connects to one server with one client profile and records what it says
// about itself. Read-only: lists only, unless read-only calls are opted in.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ProbeConfig, ProfileConfig, ServerConfig } from './config.ts';
import { findHints } from './hints.ts';
import { redact, redactHeaders, redactString } from './redact.ts';
import { SNAPSHOT_VERSION, type ReadOnlyCallRecord, type Snapshot, type ToolRecord } from './snapshot.ts';
import { buildTransport, RecordingTransport, type BuiltTransport } from './transport.ts';

export type ProbeResult =
  | { status: 'ok'; snapshot: Snapshot }
  | { status: 'skipped'; server: string; profile: string; reason: string }
  | { status: 'error'; server: string; profile: string; reason: string };

export interface ProbeOptions {
  callReadOnly?: boolean;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  // Tests inject an in-process transport here.
  transportFactory?: (server: ServerConfig, profile: ProfileConfig) => BuiltTransport;
}

const MAX_PAGES = 50;
const DEFAULT_TIMEOUT = 30_000;

type ListMethod = 'tools/list' | 'resources/list' | 'resources/templates/list' | 'prompts/list';
const LISTS: { method: ListMethod; key: string }[] = [
  { method: 'tools/list', key: 'tools' },
  { method: 'resources/list', key: 'resources' },
  { method: 'resources/templates/list', key: 'resourceTemplates' },
  { method: 'prompts/list', key: 'prompts' },
];

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function sortBy<T>(items: T[], key: (t: T) => string): T[] {
  return [...items].sort((a, b) => key(a).localeCompare(key(b)));
}

async function listAll(
  client: Client,
  rec: RecordingTransport,
  method: ListMethod,
  key: string,
  timeout: number,
): Promise<{ items: Record<string, unknown>[]; extras: Record<string, unknown> }> {
  const before = rec.results(method).length;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = cursor ? { cursor } : {};
    const opts = { timeout };
    const res =
      method === 'tools/list'
        ? await client.listTools(params, opts)
        : method === 'resources/list'
          ? await client.listResources(params, opts)
          : method === 'resources/templates/list'
            ? await client.listResourceTemplates(params, opts)
            : await client.listPrompts(params, opts);
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  const items: Record<string, unknown>[] = [];
  const extras: Record<string, unknown> = {};
  for (const ex of rec.results(method).slice(before)) {
    const result = asObject(ex.result);
    const list = result[key];
    if (Array.isArray(list)) items.push(...list.map(asObject));
    for (const [k, v] of Object.entries(result)) {
      if (k !== key && k !== 'nextCursor') extras[k] = v;
    }
  }
  return { items, extras };
}

function shapeOf(result: unknown): ReadOnlyCallRecord['shape'] {
  const r = asObject(result);
  const content = Array.isArray(r.content) ? r.content : [];
  return {
    isError: typeof r.isError === 'boolean' ? r.isError : undefined,
    result_keys: Object.keys(r).sort(),
    content_types: [...new Set(content.map((c) => String(asObject(c).type)))].sort(),
    structured_keys: Object.keys(asObject(r.structuredContent)).sort(),
    meta_keys: Object.keys(asObject(r._meta)).sort(),
  };
}

// Only tools the server itself marks readOnlyHint: true, never destructive,
// and only those the config lists with their arguments.
export function readOnlyRefusal(tool: ToolRecord | undefined): string | undefined {
  if (!tool) return 'not in tools/list';
  const a = tool.annotations ?? {};
  if (a.readOnlyHint !== true) return 'server does not mark it readOnlyHint: true';
  if (a.destructiveHint === true) return 'server marks it destructiveHint: true';
  return undefined;
}

function mergeCapabilities(profile: ProfileConfig): Record<string, unknown> {
  return structuredClone(profile.capabilities ?? {});
}

export async function probeServer(
  config: ProbeConfig,
  server: ServerConfig,
  profileName: string,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const profile = config.profiles[profileName];
  if (!profile) return { status: 'error', server: server.key, profile: profileName, reason: 'unknown profile' };
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const timeout = server.timeout_ms ?? DEFAULT_TIMEOUT;

  let built: BuiltTransport;
  try {
    built = options.transportFactory ? options.transportFactory(server, profile) : buildTransport(server, profile, env);
  } catch (err) {
    return { status: 'error', server: server.key, profile: profileName, reason: (err as Error).message };
  }
  if (built.missing.length) {
    return {
      status: 'skipped',
      server: server.key,
      profile: profileName,
      reason: `missing env ${built.missing.join(', ')}`,
    };
  }

  const capabilities = mergeCapabilities(profile);
  const rec = new RecordingTransport(built.transport);
  const client = new Client(config.client, { capabilities });
  const errors: Record<string, string> = {};
  const lists: Record<string, Record<string, unknown>[]> = {};
  const listExtras: Record<string, Record<string, unknown>> = {};
  const readOnly: ReadOnlyCallRecord[] = [];

  try {
    await client.connect(rec, { timeout });
  } catch (err) {
    await client.close().catch(() => {});
    const reason = redactString(`connect failed: ${(err as Error).message}`, built.secrets);
    return { status: 'error', server: server.key, profile: profileName, reason };
  }

  try {
    for (const { method, key } of LISTS) {
      try {
        const { items, extras } = await listAll(client, rec, method, key, timeout);
        lists[key] = items;
        if (Object.keys(extras).length) listExtras[method] = extras;
      } catch (err) {
        lists[key] = [];
        errors[method] = (err as Error).message;
      }
    }

    const tools = lists.tools as ToolRecord[];
    if (options.callReadOnly) {
      for (const call of server.read_only_calls ?? []) {
        const tool = tools.find((t) => t.name === call.tool);
        const refusal = readOnlyRefusal(tool);
        if (refusal) {
          readOnly.push({ tool: call.tool, outcome: 'refused', reason: refusal });
          continue;
        }
        try {
          await client.callTool({ name: call.tool, arguments: call.arguments }, undefined, { timeout });
          const raw = rec.results('tools/call').at(-1)?.result;
          readOnly.push({ tool: call.tool, outcome: 'called', shape: shapeOf(raw) });
        } catch (err) {
          readOnly.push({ tool: call.tool, outcome: 'error', reason: (err as Error).message });
        }
      }
    }
  } finally {
    await client.close().catch(() => {});
  }

  const init = asObject(rec.results('initialize')[0]?.result);
  const snapshot: Snapshot = {
    snapshot_version: SNAPSHOT_VERSION,
    server: server.key,
    profile: profileName,
    probed_at: now().toISOString(),
    transport: server.transport,
    target: built.target,
    request: { client: config.client, capabilities, headers: built.requestHeaders },
    initialize: init,
    tools: sortBy(lists.tools as ToolRecord[], (t) => String(t.name)),
    resources: sortBy(lists.resources ?? [], (r) => String(r.uri)),
    resource_templates: sortBy(lists.resourceTemplates ?? [], (r) => String(r.uriTemplate)),
    prompts: sortBy(lists.prompts ?? [], (p) => String(p.name)),
    list_extras: listExtras,
    notifications: [...new Set(rec.notifications.map((n) => n.method))].sort(),
    response_headers: redactHeaders(built.responseHeaders),
    stderr_head: built.stderr() || undefined,
    errors,
    read_only_calls: readOnly,
    hints: [],
  };
  snapshot.hints = findHints(snapshot);
  return { status: 'ok', snapshot: redact(snapshot, built.secrets) };
}
