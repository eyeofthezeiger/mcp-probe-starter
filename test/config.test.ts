import { describe, expect, it } from 'vitest';
import { ConfigError, expand, parseConfig } from '../src/config.ts';

const http = (extra: Record<string, unknown> = {}) => ({
  key: 'svc',
  transport: 'streamable-http',
  url: 'https://example.com/mcp',
  ...extra,
});

describe('parseConfig', () => {
  it('fills defaults', () => {
    const c = parseConfig({ servers: [http()] });
    expect(c.output_dir).toBe('out');
    expect(c.default_profiles).toEqual(['plain']);
    expect(c.profiles.plain).toEqual({});
  });

  it('refuses literal secrets in headers and env', () => {
    expect(() => parseConfig({ servers: [http({ headers: { Authorization: 'Bearer abc123' } })] })).toThrow(
      /looks secret/,
    );
    expect(() =>
      parseConfig({ servers: [{ key: 's', transport: 'stdio', command: 'x', env: { API_TOKEN: 'literal' } }] }),
    ).toThrow(/looks secret/);
    expect(() => parseConfig({ servers: [http({ headers: { Authorization: 'Bearer ${TOKEN}' } })] })).not.toThrow();
  });

  it('allows literal feature-flag headers', () => {
    expect(() => parseConfig({ servers: [http({ headers: { 'X-MCP-Features': 'some_flag' } })] })).not.toThrow();
  });

  it('catches unknown profiles, duplicate keys and unknown fields', () => {
    expect(() => parseConfig({ servers: [http({ profiles: ['nope'] })] })).toThrow(/unknown profile/);
    expect(() => parseConfig({ servers: [http(), http()] })).toThrow(/duplicate key/);
    expect(() => parseConfig({ servers: [http({ urll: 'x' })] })).toThrow(ConfigError);
  });
});

describe('expand', () => {
  it('fills placeholders, lists missing vars and remembers secrets', () => {
    const out = expand({ Authorization: 'Bearer ${TOKEN}', 'X-Other': '${MISSING}' }, { TOKEN: 'sekret-value' });
    expect(out.values.Authorization).toBe('Bearer sekret-value');
    expect(out.missing).toEqual(['MISSING']);
    expect(out.envUsed).toEqual(['TOKEN', 'MISSING']);
    expect(out.secrets.get('sekret-value')).toBe('TOKEN');
  });
});
