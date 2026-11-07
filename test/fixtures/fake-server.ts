// A small MCP server that behaves like the real ones that bite: it hides a UI
// hint unless the client advertises MCP Apps, pages its tools, sends fields
// outside the spec and mentions a feature-flag header in its instructions.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export const UI_EXTENSION = 'io.modelcontextprotocol/ui';

export interface FakeOptions {
  // Text the server leaks into its instructions, to test redaction.
  leak?: string;
  version?: string;
  extraTool?: boolean;
  // Shared log of tool calls, so tests can check what was called.
  calls?: string[];
}

export interface FakeServer {
  server: Server;
  calls: string[];
}

export function createFakeServer(options: FakeOptions = {}): FakeServer {
  const calls = options.calls ?? [];
  const server = new Server(
    { name: 'fake-server', version: options.version ?? '1.0.0' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: {},
        prompts: {},
        experimental: { 'acme/flags': { available: ['beta-forms'] } },
      },
      instructions: `Send the X-Acme-Features header to change behavior.${options.leak ? ` Seen: ${options.leak}` : ''}`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    const ui = !!(server.getClientCapabilities() as { extensions?: Record<string, unknown> } | undefined)?.extensions?.[
      UI_EXTENSION
    ];
    const page1 = [
      {
        name: 'get_thing',
        description: 'Read one thing by id. Respects read only mode.',
        inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
        outputSchema: { type: 'object' as const, properties: { id: { type: 'string' }, name: { type: 'string' } } },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: 'create_thing',
        description: 'Create a thing.',
        inputSchema: {
          type: 'object' as const,
          properties: { name: { type: 'string' }, draft: { type: 'boolean' } },
          required: ['name'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
        ...(ui ? { _meta: { ui: { resourceUri: 'ui://fake/create-form' } } } : {}),
      },
    ];
    const page2 = [
      {
        name: 'delete_thing',
        description: 'Delete a thing.',
        inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      {
        name: 'mystery',
        description: 'No annotations at all.',
        inputSchema: { type: 'object' as const },
        'x-acme-scope': 'repo',
      },
      ...(options.extraTool
        ? [{ name: 'new_tool', description: 'Appeared later.', inputSchema: { type: 'object' as const } }]
        : []),
    ];
    if (req.params?.cursor === 'p2') return { tools: page2 };
    return { tools: page1, nextCursor: 'p2' };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    calls.push(req.params.name);
    return {
      content: [{ type: 'text', text: 'private data that must not be stored' }],
      structuredContent: { id: '1', name: 'private name' },
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: 'ui://fake/create-form', name: 'create-form', mimeType: 'text/html;profile=mcp-app' }],
  }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: 'summarize', description: 'Summarize a thing.' }],
  }));

  return { server, calls };
}
