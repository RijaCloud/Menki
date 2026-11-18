// A tiny MCP stdio bridge. Authority is held by the local service, scoped to one run.
import { createInterface } from 'node:readline';
const endpoint = process.env.MENKI_BROKER;
const token = process.env.MENKI_TOOL_TOKEN;
if (!endpoint || !token) throw new Error('Menki tool connection is missing');
async function broker(action: string, body: unknown = {}) {
  const response = await fetch(endpoint!, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...(body as object) }),
  });
  const value = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(value.error ?? 'Menki refused the operation');
  return value;
}
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  let request: { id?: number | string; method?: string; params?: Record<string, unknown> } = {};
  try {
    request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result: unknown;
    if (request.method === 'initialize')
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'menki', version: '0.1.0' },
        instructions:
          'Use Menki tools to inspect projects, delegate work, update tickets and save decisions. The service enforces project permissions.',
      };
    else if (request.method === 'tools/list') result = await broker('list');
    else if (request.method === 'tools/call') {
      try {
        const output = await broker('call', request.params);
        result = { content: [{ type: 'text', text: JSON.stringify(output) }] };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: (error as Error).message }] };
      }
    } else if (request.method === 'ping') result = {};
    else {
      console.log(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Unknown method' },
        }),
      );
      continue;
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } catch {
    if (request.id !== undefined)
      console.log(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32603, message: 'Menki tool connection failed' },
        }),
      );
  }
}
