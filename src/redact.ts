// Scrubs secrets from anything we write to disk. Two passes: the exact values
// we filled from env vars, then common token shapes as a backstop.
const TOKEN_SHAPES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // common API key prefix
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bya29\.[A-Za-z0-9_-]{20,}\b/g, // Google OAuth access token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

const SENSITIVE_HEADER =
  /^(set-cookie|cookie|authorization|proxy-authorization|mcp-session-id|x-api-key|www-authenticate)$/i;

export function redactString(text: string, secrets: Map<string, string>): string {
  let out = text;
  for (const [value, name] of secrets) {
    if (value) out = out.split(value).join(`[redacted env ${name}]`);
  }
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, '[redacted token]');
  return out;
}

export function redact<T>(value: T, secrets: Map<string, string>): T {
  if (typeof value === 'string') return redactString(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[redactString(k, secrets)] = redact(v, secrets);
    return out as T;
  }
  return value;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = SENSITIVE_HEADER.test(name) ? '[redacted]' : value;
  }
  return out;
}
