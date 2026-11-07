// The shape we write per server and profile. Raw server output is kept as-is
// (after redaction) so nothing the server sent is lost.
export const SNAPSHOT_VERSION = 1;

export interface ToolRecord {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface ReadOnlyCallRecord {
  tool: string;
  outcome: 'called' | 'refused' | 'error';
  reason?: string;
  // Shape only. Never the content: results can hold private data.
  shape?: {
    isError?: boolean;
    result_keys: string[];
    content_types: string[];
    structured_keys: string[];
    meta_keys: string[];
  };
}

export interface Hint {
  kind: string;
  where: string;
  detail: string;
}

export interface Snapshot {
  snapshot_version: number;
  server: string;
  profile: string;
  probed_at: string;
  transport: 'streamable-http' | 'stdio';
  target: string;
  request: {
    client: { name: string; version: string };
    capabilities: Record<string, unknown>;
    headers: Record<string, string>;
  };
  initialize: Record<string, unknown>;
  tools: ToolRecord[];
  resources: Record<string, unknown>[];
  resource_templates: Record<string, unknown>[];
  prompts: Record<string, unknown>[];
  list_extras: Record<string, Record<string, unknown>>;
  notifications: string[];
  response_headers: Record<string, string>;
  stderr_head?: string;
  errors: Record<string, string>;
  read_only_calls: ReadOnlyCallRecord[];
  hints: Hint[];
}

// Fields that change every run and say nothing about the server.
export const VOLATILE_KEYS = new Set(['probed_at', 'stderr_head']);
export const VOLATILE_RESPONSE_HEADERS = new Set([
  'date',
  'content-length',
  'x-request-id',
  'x-github-request-id',
  'cf-ray',
  'etag',
  'age',
  'expires',
  'last-modified',
  'x-amzn-requestid',
  'x-amz-cf-id',
  'traceparent',
  'set-cookie',
  'mcp-session-id',
]);
