# mcp-probe-starter

Connects to your MCP servers and writes down what they say about themselves, including the config the docs leave out.

- Read-only. It lists things. It never calls a tool unless you opt in, and then only tools the server marks read-only.
- Tool-agnostic. Plain MCP over stdio or streamable HTTP. No client-specific code.
- Snapshots per server, diffs against the last run, and diffs between client profiles.
- Emits candidate entries for [call-registry](https://github.com/eyeofthezeiger/call-registry). All unverified.

## Why

Some server behavior only shows up for certain clients. Example: a server can attach a UI hint (`_meta` pointing at a `ui://` resource) only when the client says it supports MCP Apps. A host that renders that UI opens a form; one that doesn't, doesn't. You won't find that in a README. You find it by asking the server twice, once as each kind of client, and diffing.

That's what this does.

## Quickstart

Needs Node 22.18 or newer (CI runs Node 24). TypeScript runs directly, no build step.

```
npm ci
cp probe.config.example.json probe.config.json
npm run probe -- --only fake
```

The `fake` server is bundled, so the first run needs no network or tokens. Look in `out/`.

Then a real server:

```
cp .env.example .env        # add your own tokens
npm run probe -- --only github
```

`npm run probe` loads `.env` if it exists. Servers with missing env vars are skipped, not failed.

## What you get

```
out/
  snapshots/<server>/<profile>.json          latest snapshot
  snapshots/<server>/history/...             every run
  diffs/<server>/<profile>.<time>.md|json    changes since the last run
  profiles/<server>.<time>.md                plain vs each other profile
  registry/calls/<provider>/mcp/<id>.md      call-registry candidates
  registry/report.md                         new vs already in the registry
  runs/<time>.md                             one-screen summary
```

A snapshot holds, per server and profile:

- `initialize`: server info, protocol version, instructions, every capability (experimental too).
- `tools`, `resources`, `resource_templates`, `prompts`: the raw list results, all pages, unknown fields kept.
- `response_headers` (HTTP) and `stderr_head` (stdio): servers often print their toggles at startup.
- `errors`: list calls the server refused.
- `hints`: leads worth checking by hand. See below.

`out/` is gitignored. Snapshots are redacted, but treat them as private anyway.

## Hints

Every hint is a lead, not a fact. The prober flags:

- Capabilities, `initialize` fields, tool fields and annotations outside the core spec.
- `_meta` keys on tools, and anything pointing at a `ui://` resource.
- Tools that don't say whether they're read-only, and tools marked destructive.
- Header names, flags, env var names and config words in instructions and descriptions.
- Custom `x-` response headers and config-looking stderr lines.

## Profiles

A profile is a pretend client: extra capabilities and extra headers. Each server runs under the profiles you list.

```json
"profiles": {
  "plain": {},
  "mcp-apps": {
    "capabilities": { "extensions": { "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } } }
  },
  "github-no-form-deferral": {
    "capabilities": { "extensions": { "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } } },
    "headers": { "X-MCP-Features": "mcp_apps_disable_form_deferral" }
  }
}
```

`plain` always exists. The first profile a server lists is the baseline for profile diffs and registry candidates.

Check capability shapes against the current spec before trusting a diff. A wrong shape just means the server ignores it.

## Add a server

See [docs/adding-a-server.md](docs/adding-a-server.md). Short version:

```json
{
  "key": "slack",
  "transport": "streamable-http",
  "url": "https://example.com/mcp",
  "headers": { "Authorization": "Bearer ${SLACK_MCP_TOKEN}" },
  "profiles": ["plain", "mcp-apps"],
  "registry": { "provider": "slack", "auth_methods": ["oauth2"] }
}
```

Secrets only as `${ENV_VAR}`. The config loader refuses literal values in headers or env vars that look secret.

## Feed results into call-registry

```
npm run probe -- --registry-dir ../call-registry
```

1. Open `out/registry/report.md`. It splits candidates into new, already there, and already there but different.
2. Copy the new files you want into `call-registry/calls/...`. For the "different" ones, edit the existing file by hand.
3. In call-registry, run `npm run validate`, then open a PR.

Candidates are always `status: unverified`, with `source.kind: tools-list` and a `smoke: { kind: read, mcp_tools_list: true }` block. Profile differences for a tool land in its `notes`. Only the registry owner marks anything verified.

With `--registry-dir`, candidates are checked against that repo's schema. Without it, against the copy in `vendor/call-registry/`.

## Read-only calls (opt in)

Some config only shows up in a result's `_meta` or `structuredContent`. To look:

```json
"read_only_calls": [{ "tool": "get_me", "arguments": {} }]
```

```
npm run probe -- --call-read-only
```

It calls a listed tool only if, in that same session, the server marks it `readOnlyHint: true` and not `destructiveHint: true`. It stores the result's shape (keys and content types), never the content.

`readOnlyHint` is the server's word, not a guarantee. Only list tools you've read the docs for.

## Commands

```
npm run probe -- [options]   run the prober (see --help)
npm test                     Vitest, with a fake in-process server
npm run lint                 ESLint, Prettier check, typecheck
npm run format               Prettier write
```

Options: `--config`, `--only <key>` (repeatable), `--out`, `--registry-dir`, `--call-read-only`, `--fail-on-change` (exit 2 when anything changed, for scheduled runs).

## Run it on a schedule

Have your own agent run `npm run probe -- --fail-on-change` daily on your machine, then read `out/runs/` when it exits 2. Don't run it in CI against real accounts.

## Layout

```
src/config.ts      config schema, ${ENV} expansion, literal-secret check
src/transport.ts   stdio and HTTP transports, raw JSON-RPC recorder
src/probe.ts       one server, one profile -> snapshot
src/hints.ts       heuristics for undocumented config
src/diff.ts        snapshot diffs
src/registry.ts    call-registry candidates and merge report
src/run.ts         runs everything and writes out/
test/              Vitest, fake MCP server in test/fixtures
docs/platforms/    notes per client (what each one advertises)
```

## Security

See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
