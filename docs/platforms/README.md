# Platform notes

The prober is client-agnostic. These notes cover what specific clients send, so you can build a profile that looks like them.

What matters is the `initialize` request: the `capabilities` a client sends, and for HTTP, any headers. Servers can return different tools, `_meta` or UI hints based on those.

## Find out what your client sends

1. Point the client at a local server that logs requests (the fake in `test/fixtures` is a start).
2. Copy the `capabilities` from its `initialize` request into a profile.
3. Probe your real servers with that profile and diff it against `plain`.

Write down where each fact came from and when. Mark anything you inferred as unverified.

## Files

- [claude.md](claude.md): Claude apps and Claude Code.

Add one file per client: `vscode.md`, `cursor.md`, `codex.md` and so on.
