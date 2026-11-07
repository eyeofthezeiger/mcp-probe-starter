// Heuristics that point at config the docs may leave out. Every hint is a
// lead to check by hand, never a fact.
import type { Hint, Snapshot } from './snapshot.ts';

const STANDARD_SERVER_CAPS = new Set([
  'tools',
  'resources',
  'prompts',
  'logging',
  'completions',
  'tasks',
  'experimental',
]);
const STANDARD_INIT_KEYS = new Set(['protocolVersion', 'capabilities', 'serverInfo', 'instructions']);
const STANDARD_TOOL_KEYS = new Set([
  'name',
  'title',
  'description',
  'inputSchema',
  'outputSchema',
  'annotations',
  '_meta',
  'icons',
  'execution',
]);
const STANDARD_ANNOTATIONS = new Set(['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']);

const KNOB_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bX-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/g, label: 'header name' },
  { re: /--[a-z][a-z0-9-]{2,}/g, label: 'command-line flag' },
  { re: /[?&][a-z_]+=/g, label: 'URL query parameter' },
  { re: /\b[A-Z][A-Z0-9]+_[A-Z0-9_]{2,}\b/g, label: 'env var name' },
  { re: /\b(feature[ _-]?flags?|toolsets?|read[ _-]?only mode|lockdown|dynamic tools?)\b/gi, label: 'config term' },
];

function knobs(text: string): string[] {
  const found = new Set<string>();
  for (const { re, label } of KNOB_PATTERNS) {
    for (const m of text.matchAll(re)) found.add(`${label} ${m[0].replace(/[?&=]/g, '')}`);
  }
  return [...found].sort();
}

function walkStrings(value: unknown, path: string, visit: (path: string, s: string) => void) {
  if (typeof value === 'string') visit(path, value);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, `${path}[${i}]`, visit));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walkStrings(v, path ? `${path}.${k}` : k, visit);
  }
}

export function findHints(s: Snapshot): Hint[] {
  const hints: Hint[] = [];
  const add = (kind: string, where: string, detail: string) => hints.push({ kind, where, detail });
  const init = s.initialize;
  const caps = (init.capabilities ?? {}) as Record<string, unknown>;

  for (const k of Object.keys(init)) {
    if (!STANDARD_INIT_KEYS.has(k))
      add('initialize-extra', `initialize.${k}`, 'Field outside the core spec in the initialize result.');
  }
  for (const k of Object.keys(caps)) {
    if (!STANDARD_SERVER_CAPS.has(k))
      add('capability-nonstandard', `capabilities.${k}`, 'Capability outside the core spec.');
  }
  for (const k of Object.keys((caps.experimental ?? {}) as object)) {
    add('capability-experimental', `capabilities.experimental.${k}`, 'Experimental capability the server advertises.');
  }
  if (typeof init.instructions === 'string') {
    for (const k of knobs(init.instructions)) add('instructions-knob', 'initialize.instructions', `Mentions ${k}.`);
  }

  const metaKeys = new Map<string, string[]>();
  const noReadOnly: string[] = [];
  for (const t of s.tools) {
    for (const k of Object.keys(t)) {
      if (!STANDARD_TOOL_KEYS.has(k)) add('tool-extra', `tools.${t.name}.${k}`, 'Tool field outside the core spec.');
    }
    for (const k of Object.keys(t._meta ?? {})) metaKeys.set(k, [...(metaKeys.get(k) ?? []), t.name]);
    for (const k of Object.keys(t.annotations ?? {})) {
      if (!STANDARD_ANNOTATIONS.has(k))
        add('annotation-nonstandard', `tools.${t.name}.annotations.${k}`, 'Annotation outside the core spec.');
    }
    if (typeof t.annotations?.readOnlyHint !== 'boolean') noReadOnly.push(t.name);
    if (t.annotations?.destructiveHint === true)
      add('tool-destructive', `tools.${t.name}`, 'Server marks it destructiveHint: true.');
    if (typeof t.description === 'string') {
      for (const k of knobs(t.description)) add('description-knob', `tools.${t.name}.description`, `Mentions ${k}.`);
    }
  }
  for (const [k, names] of [...metaKeys].sort()) {
    add(
      'tool-meta',
      `tools[*]._meta.${k}`,
      `On ${names.length} tool(s): ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', ...' : ''}.`,
    );
  }
  if (noReadOnly.length) {
    add(
      'annotations-missing',
      'tools[*].annotations.readOnlyHint',
      `${noReadOnly.length} tool(s) don't say whether they're read-only.`,
    );
  }

  const uiRefs = new Set<string>();
  const byKey = (items: Record<string, unknown>[], key: string) =>
    Object.fromEntries(items.map((item) => [String(item[key]), item]));
  const keyedLists = {
    tools: byKey(s.tools, 'name'),
    resources: byKey(s.resources, 'uri'),
    resource_templates: byKey(s.resource_templates, 'uriTemplate'),
  };
  walkStrings(keyedLists, '', (path, v) => {
    if (v.startsWith('ui://')) uiRefs.add(`${path} = ${v}`);
  });
  for (const ref of [...uiRefs].sort())
    add(
      'ui-resource',
      ref.split(' = ')[0] as string,
      `Points at a ui:// resource (${ref.split(' = ')[1]}). Hosts that render MCP Apps may open it.`,
    );

  for (const [method, extras] of Object.entries(s.list_extras)) {
    for (const k of Object.keys(extras)) add('list-extra', `${method}.${k}`, 'Extra field on a list result.');
  }
  for (const n of s.notifications) {
    if (!n.startsWith('notifications/'))
      add('notification-nonstandard', n, 'Server sent a notification outside the core spec.');
  }
  for (const name of Object.keys(s.response_headers)) {
    if (name.startsWith('x-') && !/request-id|ratelimit|github-media|frame|content-type|xss/.test(name)) {
      add('response-header', `response_headers.${name}`, 'Custom response header on the first HTTP response.');
    }
  }
  if (s.stderr_head) {
    for (const line of s.stderr_head.split('\n').slice(0, 200)) {
      if (/(feature|toolset|flag|enabled|disabled|config|mode)/i.test(line)) {
        add('stderr-config', 'stderr', line.trim().slice(0, 200));
      }
    }
  }
  return hints;
}
