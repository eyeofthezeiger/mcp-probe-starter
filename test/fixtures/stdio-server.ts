// The fake server over stdio, for the stdio transport test.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFakeServer } from './fake-server.ts';

process.stderr.write('fake-server starting\ntoolsets enabled: things,prompts\n');
const { server } = createFakeServer({ leak: process.env.FAKE_STDIO_TOKEN });
await server.connect(new StdioServerTransport());
