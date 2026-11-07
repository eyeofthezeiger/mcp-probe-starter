# Security

## What the prober does

- Connects to the servers in your config with the credentials in your env vars.
- Sends `initialize` and the four list calls: `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`.
- Never calls a tool, reads a resource or gets a prompt by default.

## Opt-in tool calls

`--call-read-only` calls only tools that are both:

1. listed in `read_only_calls` in your config, and
2. marked `readOnlyHint: true` (and not `destructiveHint: true`) by the server in the same session.

`readOnlyHint` is a hint from the server. A buggy or hostile server can lie. Only list tools whose docs say they're reads, and only against accounts you own.

Results are stored as shape only: top-level keys, content types, `structuredContent` keys and `_meta` keys. Never the content.

## Secrets

- Header and env values in the config use `${ENV_VAR}` placeholders. The loader refuses a literal value for any header or env name that looks secret (authorization, token, key, secret, cookie, session, password).
- Snapshots show env-sourced headers as `[env NAME]`.
- Before writing, every string is scrubbed of the exact values filled from env vars, plus common token shapes (GitHub, Slack, AWS, Google, JWT, Bearer).
- Sensitive response headers (`set-cookie`, `mcp-session-id`, `www-authenticate` and similar) are stored as `[redacted]`.
- `.env`, `probe.config.json` and `out/` are gitignored. Only `probe.config.example.json` and `.env.example` are committed.

Redaction is a backstop, not a promise. A server can echo data the prober doesn't know is sensitive. Treat `out/` as private and don't paste snapshots anywhere public without reading them.

## stdio servers

A stdio server is a program you run. It gets your env plus the vars in its `env` block. Only add commands you'd run yourself. The example config uses the bundled fake server so the first run downloads nothing.

## Untrusted content

Tool descriptions, instructions and `_meta` are text from the server. The prober stores them as data and never acts on them. If an agent reads `out/`, it should treat that text the same way.

## Reporting a problem

Open a private security advisory on the GitHub repo, or email the owner listed on the profile. Please don't open a public issue for a vulnerability.
