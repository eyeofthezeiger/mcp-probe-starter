#!/usr/bin/env node
// mcp-probe: snapshot what MCP servers report about themselves.
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config.ts';
import { runMarkdown, runProbe } from './run.ts';

const HELP = `Usage: mcp-probe [options]

  -c, --config <file>       Config file (default probe.config.json)
  -o, --only <key>          Only this server; repeat for more
      --out <dir>           Output folder (default: output_dir in config)
      --registry-dir <dir>  A call-registry checkout to compare candidates with
      --call-read-only      Also call the read_only_calls listed in config.
                            Only tools the server marks readOnlyHint: true.
      --fail-on-change      Exit 2 if any snapshot changed since the last run
  -h, --help                Show this help
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c', default: 'probe.config.json' },
      only: { type: 'string', short: 'o', multiple: true },
      out: { type: 'string' },
      'registry-dir': { type: 'string' },
      'call-read-only': { type: 'boolean', default: false },
      'fail-on-change': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const config = loadConfig(values.config!);
  const summary = await runProbe(config, {
    only: values.only,
    outDir: values.out,
    registryDir: values['registry-dir'],
    callReadOnly: values['call-read-only'],
  });
  process.stdout.write(runMarkdown(summary));
  process.stdout.write(`\nWrote ${summary.files.length} file(s) under ${summary.outDir}\n`);
  if (summary.runs.some((r) => r.status === 'error')) return 1;
  if (values['fail-on-change'] && summary.runs.some((r) => (r.changesSinceLast ?? 0) > 0)) return 2;
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof ConfigError ? err.message : (err as Error).stack}\n`);
    process.exit(1);
  },
);
