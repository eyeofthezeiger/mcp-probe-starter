# Adding a server

Add an entry to `servers` in `probe.config.json`.

## Streamable HTTP

```json
{
  "key": "github",
  "transport": "streamable-http",
  "url": "https://api.githubcopilot.com/mcp/",
  "headers": { "Authorization": "Bearer ${GITHUB_PAT}" },
  "profiles": ["plain", "mcp-apps"],
  "registry": { "provider": "github", "auth_methods": ["personal-access-token"] }
}
```

## stdio

```json
{
  "key": "local-thing",
  "transport": "stdio",
  "command": "docker",
  "args": ["run", "-i", "--rm", "-e", "THING_TOKEN", "example/thing-mcp"],
  "env": { "THING_TOKEN": "${THING_TOKEN}" },
  "registry": {
    "provider": "thing",
    "auth_methods": ["api-token"],
    "source_url": "https://example.com/thing-mcp/README"
  }
}
```

Then add the env var to `.env` (and a blank line for it to `.env.example`).

## Fields

- `key`: lowercase, dashes. Used for folder names and the `tool.server` field in candidates.
- `profiles`: which client profiles to try. The first is the baseline. Defaults to `default_profiles`.
- `timeout_ms`: per request. Default 30000.
- `enabled: false`: keep it in the file, skip it in runs.
- `registry`: needed for call-registry candidates.
  - `provider`: the call-registry provider folder, e.g. `github`.
  - `auth_methods`: one or more of call-registry's auth methods. Say what you actually use.
  - `source_url`: required for stdio servers (no https URL to cite). The doc you read.
  - `product`, `toolset`: optional, copied into candidates.
- `read_only_calls`: tools to call with `--call-read-only`. See SECURITY.md.

## Auth

- Tokens go in env vars only. Reference them as `${NAME}` in `headers` or `env`.
- The config loader refuses literal values for anything named like a secret.
- OAuth-only servers: this starter doesn't run an OAuth sign-in. If your client stores a token you're allowed to reuse, put it in an env var. Otherwise leave the server `enabled: false`.

## Feature flags and headers

If a server documents a header or query parameter that changes behavior, add a profile for it rather than baking it into the server:

```json
"profiles": {
  "github-no-form-deferral": { "headers": { "X-MCP-Features": "mcp_apps_disable_form_deferral" } }
}
```

Then the profile diff shows exactly what the flag changes.
