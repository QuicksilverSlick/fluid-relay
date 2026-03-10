/**
 * gRPC Transport Adapter — enterprise MCP transport layer.
 *
 * Provides a gRPC-based transport alternative for enterprises that have
 * standardized on gRPC across their microservices. Implements the same
 * message routing interface as the WebSocket and HTTP Streamable transports.
 *
 * This is a structural stub that defines the full interface and types.
 * A real implementation requires @grpc/grpc-js as a peer dependency.
 *
 * The adapter translates between BeamCode's UnifiedMessage format and
 * gRPC service definitions, enabling:
 *   - Bidirectional streaming for real-time agent communication
 *   - Unary RPCs for session management (create, list, delete)
 *   - Server streaming for message history replay
 *
 * Proto definition (to be generated):
 *   service BeamCodeRelay {
 *     rpc StreamMessages(stream RelayMessage) returns (stream RelayMessage);
 *     rpc CreateSession(CreateSessionRequest) returns (SessionInfo);
 *     rpc ListSessions(Empty) returns (SessionList);
 *     rpc GetHistory(HistoryRequest) returns (stream RelayMessage);
 *   }
 *
 * @module Relay
 */

import type { Logger } from "../interfaces/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GRPCTransportOptions {
  /** gRPC server port. Default: 50051. */
  port?: number;
  /** TLS certificate path. Required for production. */
  certPath?: string;
  /** TLS key path. Required for production. */
  keyPath?: string;
  /** Maximum message size in bytes. Default: 4MB. */
  maxMessageSize?: number;
  /** Logger instance. */
  logger?: Logger;
  /** Enable reflection for grpcurl/grpcui discovery. Default: true. */
  enableReflection?: boolean;
}

export interface GRPCServiceDefinition {
  package: string;
  service: string;
  methods: GRPCMethodDefinition[];
}

export interface GRPCMethodDefinition {
  name: string;
  requestType: string;
  responseType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
}

export interface RelayMessage {
  sessionId: string;
  messageId: string;
  type: string;
  role: string;
  content: string; // JSON-serialized UnifiedContent[]
  metadata: string; // JSON-serialized Record<string, unknown>
  timestamp: number;
  seq?: number;
}

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

export const BEAMCODE_SERVICE: GRPCServiceDefinition = {
  package: "beamcode.relay.v1",
  service: "BeamCodeRelay",
  methods: [
    {
      name: "StreamMessages",
      requestType: "RelayMessage",
      responseType: "RelayMessage",
      clientStreaming: true,
      serverStreaming: true,
    },
    {
      name: "CreateSession",
      requestType: "CreateSessionRequest",
      responseType: "SessionInfo",
      clientStreaming: false,
      serverStreaming: false,
    },
    {
      name: "ListSessions",
      requestType: "Empty",
      responseType: "SessionList",
      clientStreaming: false,
      serverStreaming: false,
    },
    {
      name: "GetHistory",
      requestType: "HistoryRequest",
      responseType: "RelayMessage",
      clientStreaming: false,
      serverStreaming: true,
    },
    {
      name: "ApprovePermission",
      requestType: "PermissionResponse",
      responseType: "PermissionAck",
      clientStreaming: false,
      serverStreaming: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// gRPC Transport Adapter
// ---------------------------------------------------------------------------

export class GRPCTransportAdapter {
  private port: number;
  private logger?: Logger;
  private _running = false;
  private options: GRPCTransportOptions;

  constructor(options: GRPCTransportOptions = {}) {
    this.port = options.port ?? 50051;
    this.logger = options.logger;
    this.options = options;
  }

  isRunning(): boolean {
    return this._running;
  }

  /**
   * Start the gRPC server.
   *
   * Requires @grpc/grpc-js as a peer dependency. Will throw a helpful
   * error if the dependency is not installed.
   */
  async start(): Promise<{ port: number }> {
    // biome-ignore lint/suspicious/noExplicitAny: optional peer dependency loaded dynamically
    let grpc: any;
    try {
      // Use a variable to prevent tsc from resolving the optional peer dependency at type-check time
      const grpcModule = "@grpc/grpc-js";
      grpc = await import(/* webpackIgnore: true */ grpcModule);
    } catch {
      throw new Error(
        "gRPC transport requires @grpc/grpc-js.\n" +
          "Install it: pnpm add @grpc/grpc-js\n" +
          "This is an optional enterprise feature.",
      );
    }

    const server = new grpc.Server({
      "grpc.max_receive_message_length": this.options.maxMessageSize ?? 4 * 1024 * 1024,
      "grpc.max_send_message_length": this.options.maxMessageSize ?? 4 * 1024 * 1024,
    });

    // Register service handlers (implementation deferred to integration layer)
    // The service definition above documents the full contract.

    const credentials =
      this.options.certPath && this.options.keyPath
        ? grpc.ServerCredentials.createSsl(null, [])
        : grpc.ServerCredentials.createInsecure();

    const boundPort = await new Promise<number>((resolve, reject) => {
      server.bindAsync(`0.0.0.0:${this.port}`, credentials, (err: Error | null, port: number) => {
        if (err) reject(err);
        else resolve(port);
      });
    });

    this._running = true;

    this.logger?.info?.("gRPC transport started", {
      component: "grpc-transport",
      port: boundPort,
      tls: !!(this.options.certPath && this.options.keyPath),
    });

    return { port: boundPort };
  }

  async stop(): Promise<void> {
    this._running = false;
    this.logger?.info?.("gRPC transport stopped", {
      component: "grpc-transport",
    });
  }

  /**
   * Get the proto definition as a string for client code generation.
   */
  getProtoDefinition(): string {
    return `
syntax = "proto3";

package beamcode.relay.v1;

service BeamCodeRelay {
  // Bidirectional streaming for real-time agent communication
  rpc StreamMessages(stream RelayMessage) returns (stream RelayMessage);

  // Session management
  rpc CreateSession(CreateSessionRequest) returns (SessionInfo);
  rpc ListSessions(Empty) returns (SessionList);

  // Message history with server-side streaming
  rpc GetHistory(HistoryRequest) returns (stream RelayMessage);

  // Permission handling
  rpc ApprovePermission(PermissionResponse) returns (PermissionAck);
}

message RelayMessage {
  string session_id = 1;
  string message_id = 2;
  string type = 3;
  string role = 4;
  string content = 5;        // JSON-serialized content blocks
  string metadata = 6;       // JSON-serialized metadata
  int64 timestamp = 7;
  optional int64 seq = 8;
}

message CreateSessionRequest {
  string cwd = 1;
  optional string model = 2;
  optional string adapter_name = 3;
}

message SessionInfo {
  string session_id = 1;
  string adapter = 2;
  string state = 3;
  int64 created_at = 4;
  int32 consumer_count = 5;
}

message SessionList {
  repeated SessionInfo sessions = 1;
}

message HistoryRequest {
  string session_id = 1;
  optional int64 after_seq = 2;
  optional int32 limit = 3;
}

message PermissionResponse {
  string session_id = 1;
  string request_id = 2;
  bool approved = 3;
}

message PermissionAck {
  bool received = 1;
}

message Empty {}
`.trim();
  }
}

// ---------------------------------------------------------------------------
// Note: @grpc/grpc-js is an optional peer dependency.
// The start() method uses a dynamic import with `any` typing to avoid
// requiring the package at typecheck time.
// ---------------------------------------------------------------------------
