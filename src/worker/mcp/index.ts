import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticate } from "../lib/auth";
import { registerTools, type McpEnv } from "./tools";

/**
 * MCP server, mounted at /mcp.
 *
 * Stateless mode (no `sessionIdGenerator`) with `enableJsonResponse`: every
 * tool call here is a single read against D1, never a long-running or
 * server-push operation, so there is no session worth tracking and nothing an
 * SSE stream would buy. A fresh server and transport per request is the SDK's
 * documented pattern for serverless runtimes, where in-memory state does not
 * reliably survive between requests anyway.
 */
export async function handleMcpRequest(request: Request, env: McpEnv & { DB: D1Database }): Promise<Response> {
  const key = await authenticate(request, env.DB);
  if (!key) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "Unauthorized. Get a free API key: curl -X POST https://nasheed.lomeyo.com/api/v1/keys " +
            '-H "Content-Type: application/json" -d \'{"name":"my-agent"}\'',
        },
        id: null,
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="nasheed-directory-mcp"',
        },
      }
    );
  }

  const server = new McpServer({ name: "nasheed-directory", version: "0.1.0" });
  registerTools(server, env, key);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}

export type { McpEnv } from "./tools";
