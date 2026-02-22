/**
 * CliGateway — BackendPlane inverted CLI socket acceptance.
 *
 * Accepts inbound WebSocket connections from locally-spawned CLI processes
 * (inverted connection model), delivers the socket to the appropriate
 * BackendAdapter, and triggers backend connection via SessionBridge.
 *
 * @module BackendPlane
 */

import type { WebSocketLike } from "../../interfaces/transport.js";
import type { CliAdapterName } from "../interfaces/adapter-names.js";
import type { InvertedConnectionAdapter } from "../interfaces/inverted-connection-adapter.js";
import { isInvertedConnectionAdapter } from "../interfaces/inverted-connection-adapter.js";
import type { SessionTransportHubDeps } from "../interfaces/session-coordinator-coordination.js";
import { BufferedWebSocket } from "./buffered-websocket.js";

type CliSocket = WebSocketLike & {
  on(event: "message", handler: (data: string | Buffer) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: Error) => void): void;
};

/**
 * CliGateway owns inverted CLI socket acceptance and adapter delivery.
 */
export class CliGateway {
  constructor(private readonly deps: SessionTransportHubDeps) {}

  handleCliConnection(socket: CliSocket, sessionId: string): void {
    const info = this.deps.launcher.getSession(sessionId);
    if (!info || info.state !== "starting") {
      this.deps.logger.warn(
        `Rejecting unexpected CLI connection for session ${sessionId} (state=${info?.state ?? "unknown"})`,
      );
      socket.close();
      return;
    }

    const adapterName = info.adapterName;
    let invertedAdapter: InvertedConnectionAdapter | null = null;
    if (adapterName && this.deps.adapterResolver) {
      const resolved = this.deps.adapterResolver.resolve(adapterName as CliAdapterName);
      if (isInvertedConnectionAdapter(resolved)) {
        invertedAdapter = resolved;
      }
    } else if (this.deps.adapter && isInvertedConnectionAdapter(this.deps.adapter)) {
      invertedAdapter = this.deps.adapter;
    }

    if (!invertedAdapter) {
      this.deps.logger.warn(
        `No adapter configured, cannot handle CLI connection for session ${sessionId}`,
      );
      socket.close();
      return;
    }

    const adapter = invertedAdapter;
    const socketForAdapter = new BufferedWebSocket(socket).asSocket();

    this.deps.bridge.setAdapterName(sessionId, adapterName ?? this.deps.adapter?.name ?? "unknown");
    this.deps.bridge
      .connectBackend(sessionId)
      .then(() => {
        const ok = adapter.deliverSocket(sessionId, this.deps.toAdapterSocket(socketForAdapter));
        if (!ok) {
          adapter.cancelPending(sessionId);
          this.deps.logger.warn(`Failed to deliver socket for session ${sessionId}, closing`);
          socket.close();
        }
      })
      .catch((err) => {
        adapter.cancelPending(sessionId);
        this.deps.logger.warn(`Failed to connect backend for session ${sessionId}: ${err}`);
        socket.close();
      });
  }
}
