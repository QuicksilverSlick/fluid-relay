/**
 * HTTP Streamable Transport — MCP 2025-03 compliant transport layer.
 *
 * Replaces the cloudflared tunnel dependency with a standard HTTP endpoint
 * that uses Server-Sent Events (SSE) for server→client streaming and
 * regular POST for client→server messages.
 *
 * Benefits over cloudflared:
 *   - No binary dependency required
 *   - Works through corporate proxies and firewalls
 *   - Aligns with MCP 2025-03 specification
 *   - E2E encryption (libsodium) still applies at the message layer
 *
 * Protocol:
 *   POST /mcp/stream   — client sends JSON-RPC message
 *   GET  /mcp/stream   — client receives SSE notification stream
 *   GET  /mcp/health    — health check
 *
 * @module Relay
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Logger } from "../interfaces/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreamableTransportOptions {
  /** Logger for transport events. */
  logger?: Logger;
  /** Maximum number of concurrent SSE connections. Default: 100. */
  maxConnections?: number;
  /** Heartbeat interval in ms for SSE keep-alive. Default: 30000. */
  heartbeatMs?: number;
  /** Session-to-handler mapping for routing inbound messages. */
  onMessage?: (sessionId: string, data: unknown) => void;
}

interface SSEConnection {
  id: string;
  sessionId: string;
  res: ServerResponse;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// HTTP Streamable Transport
// ---------------------------------------------------------------------------

export class HttpStreamableTransport {
  private connections = new Map<string, SSEConnection>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private logger?: Logger;
  private maxConnections: number;
  private heartbeatMs: number;
  private onMessage?: (sessionId: string, data: unknown) => void;
  private _running = false;

  constructor(options: StreamableTransportOptions = {}) {
    this.logger = options.logger;
    this.maxConnections = options.maxConnections ?? 100;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.onMessage = options.onMessage;
  }

  isRunning(): boolean {
    return this._running;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * Start the transport (begins heartbeat timer).
   * Attach to an existing HTTP server by routing requests through handleRequest().
   */
  start(): void {
    this._running = true;

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeats();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref();

    this.logger?.info?.("HTTP streamable transport started", {
      component: "http-streamable",
    });
  }

  stop(): void {
    this._running = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Close all SSE connections
    for (const [id, conn] of this.connections) {
      try {
        conn.res.end();
      } catch {
        // Connection may already be closed.
      }
      this.connections.delete(id);
    }

    this.logger?.info?.("HTTP streamable transport stopped", {
      component: "http-streamable",
    });
  }

  /**
   * Handle an incoming HTTP request. Mount this on your HTTP server
   * for paths under /mcp/*.
   *
   * Returns true if the request was handled, false if not a known route.
   */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Session-Id",
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }

    switch (pathname) {
      case "/mcp/health":
        return this.handleHealth(res);

      case "/mcp/stream":
        if (req.method === "GET") {
          return this.handleSSEConnect(req, res);
        }
        if (req.method === "POST") {
          return this.handlePostMessage(req, res);
        }
        res.writeHead(405);
        res.end();
        return true;

      default:
        return false;
    }
  }

  /**
   * Send a message to all SSE connections subscribed to a session.
   */
  broadcast(sessionId: string, event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const conn of this.connections.values()) {
      if (conn.sessionId === sessionId) {
        try {
          conn.res.write(payload);
        } catch {
          // Connection dead — will be cleaned up by heartbeat.
          this.connections.delete(conn.id);
        }
      }
    }
  }

  /**
   * Send a message to all SSE connections regardless of session.
   */
  broadcastAll(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const [id, conn] of this.connections) {
      try {
        conn.res.write(payload);
      } catch {
        this.connections.delete(id);
      }
    }
  }

  // ── Route Handlers ───────────────────────────────────────────────────────

  private handleHealth(res: ServerResponse): true {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        transport: "http-streamable",
        connections: this.connections.size,
        maxConnections: this.maxConnections,
      }),
    );
    return true;
  }

  private handleSSEConnect(
    req: IncomingMessage,
    res: ServerResponse,
  ): true {
    if (this.connections.size >= this.maxConnections) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many connections" }));
      return true;
    }

    const sessionId =
      (req.headers["x-session-id"] as string) ??
      new URL(req.url ?? "/", "http://localhost").searchParams.get("session") ??
      "*";

    const connectionId = randomUUID();

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Connection-Id": connectionId,
    });

    // Send initial connection event
    res.write(
      `event: connected\ndata: ${JSON.stringify({ connectionId, sessionId })}\n\n`,
    );

    const conn: SSEConnection = {
      id: connectionId,
      sessionId,
      res,
      createdAt: Date.now(),
    };
    this.connections.set(connectionId, conn);

    this.logger?.debug?.("SSE connection opened", {
      component: "http-streamable",
      connectionId,
      sessionId,
    });

    // Cleanup on close
    req.on("close", () => {
      this.connections.delete(connectionId);
      this.logger?.debug?.("SSE connection closed", {
        component: "http-streamable",
        connectionId,
      });
    });

    return true;
  }

  private async handlePostMessage(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<true> {
    try {
      const body = await readRequestBody(req);
      const parsed = JSON.parse(body) as Record<string, unknown>;

      const sessionId =
        (req.headers["x-session-id"] as string) ??
        (parsed.sessionId as string) ??
        "";

      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Missing sessionId in body or X-Session-Id header",
          }),
        );
        return true;
      }

      if (this.onMessage) {
        this.onMessage(sessionId, parsed);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received: true, sessionId }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }

    return true;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private sendHeartbeats(): void {
    const payload = `event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`;

    for (const [id, conn] of this.connections) {
      try {
        conn.res.write(payload);
      } catch {
        this.connections.delete(id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
