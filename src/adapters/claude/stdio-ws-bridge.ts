/**
 * StdioWebSocketBridge — bridges a CLI process's stdin/stdout to a WebSocket.
 *
 * Claude CLI 2.x communicates via stdin/stdout in stream-json (NDJSON) mode.
 * BeamCode's inverted-connection architecture expects the CLI to connect back
 * via WebSocket. This bridge fills the gap by:
 *
 *   1. Creating a local WebSocket client to ws://localhost:<port>/ws/cli/<sessionId>
 *   2. Forwarding CLI stdout (via process:stdout events) → WebSocket messages
 *   3. Forwarding WebSocket messages → CLI stdin
 *
 * This allows the rest of the BeamCode pipeline (CliGateway → ClaudeAdapter →
 * ClaudeSession → SessionBridge) to work unchanged.
 */

import WebSocket from "ws";
import type { Logger } from "../../interfaces/logger.js";
import { noopLogger } from "../../utils/noop-logger.js";

export interface StdioWebSocketBridgeOptions {
  /** Session ID used to construct the WebSocket path. */
  sessionId: string;
  /** Port of the local WebSocket server. */
  port: number;
  /** WritableStream connected to the CLI process's stdin. */
  stdin: WritableStream<Uint8Array>;
  /** Optional logger for diagnostics. */
  logger?: Logger;
}

export class StdioWebSocketBridge {
  private ws: WebSocket | null = null;
  private buffer: string[] = [];
  private stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
  private encoder = new TextEncoder();
  private closed = false;
  private readonly logger: Logger;

  constructor(private readonly options: StdioWebSocketBridgeOptions) {
    this.logger = options.logger ?? noopLogger;
    this.stdinWriter = options.stdin.getWriter();
    this.connect();
  }

  private connect(): void {
    const url = `ws://127.0.0.1:${this.options.port}/ws/cli/${this.options.sessionId}`;
    this.logger.info("StdioBridge connecting", { url, sessionId: this.options.sessionId });

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.logger.info("StdioBridge WebSocket connected", {
        sessionId: this.options.sessionId,
        bufferedMessages: this.buffer.length,
      });
      // Flush buffered stdout data that arrived before the WebSocket opened
      for (const data of this.buffer) {
        this.ws!.send(data);
      }
      this.buffer.length = 0;
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      if (this.closed) return;
      const text = typeof data === "string" ? data : data.toString();
      this.stdinWriter.write(this.encoder.encode(text)).catch((err) => {
        this.logger.warn(`StdioBridge stdin write error: ${err}`);
      });
    });

    this.ws.on("error", (err: Error) => {
      this.logger.warn(`StdioBridge WebSocket error: ${err.message}`, {
        sessionId: this.options.sessionId,
      });
    });

    this.ws.on("close", () => {
      this.logger.info("StdioBridge WebSocket closed", {
        sessionId: this.options.sessionId,
      });
      this.close();
    });
  }

  /**
   * Forward CLI stdout data to the WebSocket.
   * Called from the launcher's process:stdout event handler.
   */
  sendStdout(data: string): void {
    if (this.closed) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      // Buffer until the WebSocket is open
      this.buffer.push(data);
    }
  }

  /** Tear down the bridge (called on process exit or session kill). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stdinWriter.close().catch(() => {});
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close();
    }
    this.ws = null;
  }
}
