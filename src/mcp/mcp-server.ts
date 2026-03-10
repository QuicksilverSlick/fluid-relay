/**
 * MCP Server Surface — exposes BeamCode sessions as MCP tools.
 *
 * Implements the Model Context Protocol server interface so orchestrators
 * (Claude Desktop, Cursor, other Claude Code instances) can discover and
 * interact with active BeamCode sessions programmatically.
 *
 * Tools exposed:
 *   - list_sessions: enumerate active sessions with metadata
 *   - send_message: send a user message to a specific session
 *   - get_history: retrieve message history for a session
 *   - approve_permission: respond to a pending permission request
 *   - get_session_status: get detailed status of a session
 *
 * @module MCP
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { SessionCoordinator } from "../core/session-coordinator.js";
import { createUnifiedMessage, type UnifiedMessage } from "../core/types/unified-message.js";
import type { Logger } from "../interfaces/logger.js";

// ---------------------------------------------------------------------------
// MCP Protocol Types (subset needed for tool serving)
// ---------------------------------------------------------------------------

interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface MCPToolCall {
  method: "tools/call";
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface MCPListToolsRequest {
  method: "tools/list";
}

interface MCPInitializeRequest {
  method: "initialize";
  params?: {
    protocolVersion?: string;
    clientInfo?: { name: string; version: string };
  };
}

type MCPRequest = MCPInitializeRequest | MCPListToolsRequest | MCPToolCall;

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

const TOOLS: MCPToolDefinition[] = [
  {
    name: "list_sessions",
    description:
      "List all active BeamCode sessions with their adapter type, status, and consumer count.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "send_message",
    description:
      "Send a user message to a specific BeamCode session. The message will be forwarded to the underlying agent (Claude Code, Codex, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The session ID to send the message to.",
        },
        text: {
          type: "string",
          description: "The message text to send.",
        },
      },
      required: ["sessionId", "text"],
    },
  },
  {
    name: "get_history",
    description:
      "Retrieve the message history for a BeamCode session. Supports pagination via lastSeq.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The session ID to get history for.",
        },
        lastSeq: {
          type: "number",
          description: "Return messages after this sequence number. Omit for full history.",
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to return. Default: 50.",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "approve_permission",
    description: "Respond to a pending permission request in a BeamCode session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The session ID with the pending permission.",
        },
        requestId: {
          type: "string",
          description: "The permission request ID to respond to.",
        },
        approved: {
          type: "boolean",
          description: "Whether to approve (true) or deny (false) the request.",
        },
      },
      required: ["sessionId", "requestId", "approved"],
    },
  },
  {
    name: "get_session_status",
    description:
      "Get detailed status of a specific BeamCode session including backend state, consumer count, and team info.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The session ID to inspect.",
        },
      },
      required: ["sessionId"],
    },
  },
];

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export interface MCPServerOptions {
  /** The SessionCoordinator to expose. */
  coordinator: SessionCoordinator;
  /** Port to listen on. Default: 9415. */
  port?: number;
  /** Logger instance. */
  logger?: Logger;
}

export class MCPServer {
  private coordinator: SessionCoordinator;
  private port: number;
  private logger?: Logger;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(options: MCPServerOptions) {
    this.coordinator = options.coordinator;
    this.port = options.port ?? 9415;
    this.logger = options.logger;
  }

  /**
   * Start the MCP server on the configured port.
   * Uses HTTP streamable transport (POST for requests, SSE for notifications).
   */
  async start(): Promise<{ port: number }> {
    this.server = createServer((req, res) => this.handleRequest(req, res));

    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server?.on("error", reject);
      server?.listen(this.port, () => resolve());
    });

    this.logger?.info?.("MCP server started", {
      component: "mcp",
      port: this.port,
    });

    return { port: this.port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.server = null;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers for cross-origin MCP clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as {
        jsonrpc: string;
        id: string | number;
        method: string;
        params?: unknown;
      };

      const response = await this.dispatch(parsed as MCPRequest & { id: string | number });
      response.id = parsed.id;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: `Parse error: ${message}` },
        }),
      );
    }
  }

  private async dispatch(request: MCPRequest & { id: string | number }): Promise<MCPResponse> {
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "2025-03-26",
            serverInfo: {
              name: "beamcode",
              version: "0.2.0",
            },
            capabilities: {
              tools: { listChanged: false },
            },
          },
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: TOOLS },
        };

      case "tools/call":
        return this.handleToolCall(request);

      default: {
        const req = request as MCPRequest & { id: string | number; method: string };
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
      }
    }
  }

  private async handleToolCall(
    request: MCPToolCall & { id: string | number },
  ): Promise<MCPResponse> {
    const { name, arguments: args } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case "list_sessions":
          result = this.listSessions();
          break;

        case "send_message":
          result = await this.sendMessage(args.sessionId as string, args.text as string);
          break;

        case "get_history":
          result = this.getHistory(
            args.sessionId as string,
            args.lastSeq as number | undefined,
            args.limit as number | undefined,
          );
          break;

        case "approve_permission":
          result = await this.approvePermission(
            args.sessionId as string,
            args.requestId as string,
            args.approved as boolean,
          );
          break;

        case "get_session_status":
          result = this.getSessionStatus(args.sessionId as string);
          break;

        default:
          return {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32602, message: `Unknown tool: ${name}` },
          };
      }

      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        },
      };
    }
  }

  // ── Tool Implementations ─────────────────────────────────────────────────
  // All tool methods use the coordinator's public API:
  //   - registry.listSessions() / registry.getSession()  → SessionInfo
  //   - getSessionSnapshot()                              → SessionSnapshot
  //   - store.get()                                       → Session (data access)
  //   - backendConnector.sendToBackend()                  → message routing

  private listSessions(): unknown {
    const sessions = this.coordinator.registry.listSessions();
    return sessions.map((s) => {
      const snapshot = this.coordinator.getSessionSnapshot(s.sessionId);
      return {
        sessionId: s.sessionId,
        adapter: s.adapterName ?? "unknown",
        state: s.state,
        createdAt: s.createdAt,
        consumerCount: snapshot?.consumerCount ?? 0,
      };
    });
  }

  private async sendMessage(sessionId: string, text: string): Promise<unknown> {
    const storeSession = this.coordinator.store.get(sessionId);
    if (!storeSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const message: UnifiedMessage = createUnifiedMessage({
      type: "user_message",
      role: "user",
      content: [{ type: "text", text }],
      metadata: { source: "mcp" },
    });

    this.coordinator.backendConnector.sendToBackend(storeSession, message);
    return { sent: true, sessionId, messageId: message.id };
  }

  private getHistory(sessionId: string, lastSeq?: number, limit?: number): unknown {
    const snapshot = this.coordinator.getSessionSnapshot(sessionId);
    if (!snapshot) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const storeSession = this.coordinator.store.get(sessionId);
    const history = storeSession?.data.messageHistory ?? [];
    const effectiveLimit = limit ?? 50;
    const afterSeq = lastSeq ?? -1;

    const filtered = history.filter((_msg, idx) => idx > afterSeq).slice(0, effectiveLimit);

    return {
      sessionId,
      messages: filtered.map((msg) => {
        // ConsumerMessage is a union — safely extract common fields
        const typed = msg as Record<string, unknown>;
        return {
          type: typed.type ?? "unknown",
          ...(typed.id != null && { id: typed.id }),
          ...(typed.role != null && { role: typed.role }),
          ...(typed.content != null && { content: typed.content }),
          ...(typed.timestamp != null && { timestamp: typed.timestamp }),
        };
      }),
      total: history.length,
    };
  }

  private async approvePermission(
    sessionId: string,
    requestId: string,
    approved: boolean,
  ): Promise<unknown> {
    const storeSession = this.coordinator.store.get(sessionId);
    if (!storeSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const response: UnifiedMessage = createUnifiedMessage({
      type: "permission_response",
      role: "user",
      content: [],
      metadata: {
        requestId,
        approved,
        source: "mcp",
      },
    });

    this.coordinator.backendConnector.sendToBackend(storeSession, response);
    return { sessionId, requestId, approved };
  }

  private getSessionStatus(sessionId: string): unknown {
    const snapshot = this.coordinator.getSessionSnapshot(sessionId);
    if (!snapshot) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const info = this.coordinator.registry.getSession(sessionId);
    return {
      sessionId,
      adapter: info?.adapterName ?? "unknown",
      lifecycleState: snapshot.lifecycle ?? snapshot.state,
      backendConnected: snapshot.cliConnected,
      consumerCount: snapshot.consumerCount,
      pendingPermissions: snapshot.pendingPermissions.length,
      messageCount: snapshot.messageHistoryLength,
      lastActivity: snapshot.lastActivity,
      lastStatus: snapshot.lastStatus,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
