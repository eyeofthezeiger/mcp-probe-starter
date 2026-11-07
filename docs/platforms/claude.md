# Claude

Unverified notes. Confirm before you rely on them.

## Observed

- 2026-11-07, Matt, work org: in Claude, a GitHub MCP `create_pull_request` call opened a PR form artifact that then broke. It stopped after a "show UI"-type setting was changed. The exact setting name isn't confirmed.
- GitHub's MCP server docs list a UI resource for that tool and a feature flag, `mcp_apps_disable_form_deferral`, that runs write tools directly instead of opening a form first. It's sent as `X-MCP-Features` on the remote server. That's the closest documented match, not a confirmed cause. See call-registry entry `github.mcp.create_pull_request`.

## How to check

1. Probe GitHub with the `plain`, `mcp-apps` and `github-no-form-deferral` profiles from the example config.
2. Read `out/profiles/github.*.md`. Look for `_meta` and `ui://` changes on `create_pull_request`.
3. Record what you find in call-registry, still unverified, until you've confirmed it in the client.

## To fill in

- The exact capabilities Claude clients send in `initialize`. Capture them, don't guess.
- The name and location of the UI setting that fixed the PR artifact.
