// Probe config: which servers to connect to, which client profiles to try,
// and how to describe each server to call-registry. Secrets never live here:
// header and env values use ${ENV_VAR} placeholders that are filled at run time.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g;
const SECRET_NAME = /(authorization|token|secret|password|cookie|session|api[-_]?key|^key$|-key$|_key$)/i;

const KEY = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'use lowercase letters, digits and dashes');

const AUTH_METHODS = [
  'oauth2',
  'bot-token',
  'user-token',
  'personal-access-token',
  'plan-access-token',
  'api-token',
  'service-account',
  'app-token',
  'none',
] as const;

const ProfileSchema = z.strictObject({
  description: z.string().optional(),
  // Merged into the client capabilities sent in initialize. This is how you
  // pretend to be a client that supports, say, MCP Apps UI.
  capabilities: z.record(z.string(), z.unknown()).optional(),
  // Extra HTTP headers for streamable-http servers, e.g. a documented
  // feature-flag header. Literal values only for non-secret headers.
  headers: z.record(z.string(), z.string()).optional(),
});

const RegistrySchema = z.strictObject({
  provider: z.string().regex(/^[a-z0-9-]+$/),
  product: z.string().optional(),
  auth_methods: z.array(z.enum(AUTH_METHODS)).min(1),
  // Needed for stdio servers (no https URL to cite). The doc or README you
  // read for this server.
  source_url: z
    .string()
    .regex(/^https:\/\//)
    .optional(),
  toolset: z.string().optional(),
});

const ReadOnlyCallSchema = z.strictObject({
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

const Common = {
  key: KEY,
  description: z.string().optional(),
  profiles: z.array(KEY).min(1).optional(),
  timeout_ms: z.number().int().positive().max(600_000).optional(),
  registry: RegistrySchema.optional(),
  read_only_calls: z.array(ReadOnlyCallSchema).optional(),
  enabled: z.boolean().optional(),
};

const HttpServerSchema = z.strictObject({
  ...Common,
  transport: z.literal('streamable-http'),
  url: z.string().regex(/^https?:\/\//),
  headers: z.record(z.string(), z.string()).optional(),
});

const StdioServerSchema = z.strictObject({
  ...Common,
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const ServerSchema = z.discriminatedUnion('transport', [HttpServerSchema, StdioServerSchema]);

export const ConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  output_dir: z.string().default('out'),
  client: z.strictObject({ name: z.string(), version: z.string() }).default({ name: 'mcp-probe', version: '0.1.0' }),
  default_profiles: z.array(KEY).min(1).default(['plain']),
  profiles: z.record(KEY, ProfileSchema).default({ plain: {} }),
  servers: z.array(ServerSchema).min(1),
});

export type ProbeConfig = z.infer<typeof ConfigSchema>;
export type ServerConfig = z.infer<typeof ServerSchema>;
export type ProfileConfig = z.infer<typeof ProfileSchema>;
export type ReadOnlyCall = z.infer<typeof ReadOnlyCallSchema>;

export class ConfigError extends Error {}

export function placeholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

function checkLiteralSecrets(where: string, map: Record<string, string> | undefined, problems: string[]) {
  for (const [name, value] of Object.entries(map ?? {})) {
    if (SECRET_NAME.test(name) && placeholders(value).length === 0) {
      problems.push(`${where}.${name} looks secret; use a \${ENV_VAR} placeholder instead of a literal value`);
    }
  }
}

export function parseConfig(raw: unknown): ProbeConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Config is invalid:\n${lines.join('\n')}`);
  }
  const config = result.data;
  // "plain" is the built-in baseline: no optional capabilities, no extra headers.
  config.profiles.plain ??= {};
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const p of config.default_profiles) {
    if (!config.profiles[p]) problems.push(`default_profiles: unknown profile "${p}"`);
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    checkLiteralSecrets(`profiles.${name}.headers`, profile.headers, problems);
  }
  for (const s of config.servers) {
    if (seen.has(s.key)) problems.push(`servers: duplicate key "${s.key}"`);
    seen.add(s.key);
    for (const p of s.profiles ?? []) {
      if (!config.profiles[p]) problems.push(`servers.${s.key}.profiles: unknown profile "${p}"`);
    }
    if (s.transport === 'streamable-http') checkLiteralSecrets(`servers.${s.key}.headers`, s.headers, problems);
    if (s.transport === 'stdio') checkLiteralSecrets(`servers.${s.key}.env`, s.env, problems);
  }
  if (problems.length) throw new ConfigError(`Config is invalid:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  return config;
}

export function loadConfig(path: string): ProbeConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`Can't read ${path}. Copy probe.config.example.json to ${path} first.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}

export function profilesFor(config: ProbeConfig, server: ServerConfig): string[] {
  return server.profiles ?? config.default_profiles;
}

// Fills ${ENV_VAR} placeholders. Returns the filled map, the env vars used and
// the secret values so they can be scrubbed from anything we write.
export interface Expanded {
  values: Record<string, string>;
  envUsed: string[];
  missing: string[];
  secrets: Map<string, string>; // value -> env var name
}

export function expand(map: Record<string, string> | undefined, env: NodeJS.ProcessEnv): Expanded {
  const out: Expanded = { values: {}, envUsed: [], missing: [], secrets: new Map() };
  for (const [name, template] of Object.entries(map ?? {})) {
    out.values[name] = template.replace(PLACEHOLDER, (_m, v: string) => {
      if (!out.envUsed.includes(v)) out.envUsed.push(v);
      const value = env[v];
      if (value === undefined || value === '') {
        if (!out.missing.includes(v)) out.missing.push(v);
        return '';
      }
      if (value.length >= 4) out.secrets.set(value, v);
      return value;
    });
  }
  return out;
}
