import type { WebSocketLike } from "../../interfaces/transport.js";

export type SocketEvent = "message" | "close" | "error";

export type BufferedSocketLike = WebSocketLike & {
  on(event: "message", handler: (data: string | Buffer) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: Error) => void): void;
};

/**
 * BufferedWebSocket records early inbound messages until the adapter
 * registers its first message handler, then replays exactly once.
 */
export class BufferedWebSocket {
  private bufferedMessages: unknown[] = [];
  private buffering = true;
  private replayed = false;
  private closedOrErrored = false;

  constructor(private readonly socket: BufferedSocketLike) {
    this.socket.on("message", (data: unknown) => {
      if (this.buffering) this.bufferedMessages.push(data);
    });
    const stopBuffering = () => {
      this.closedOrErrored = true;
      this.buffering = false;
      this.bufferedMessages.length = 0;
    };
    this.socket.on("close", stopBuffering);
    this.socket.on("error", stopBuffering);
  }

  asSocket(): BufferedSocketLike {
    const socket = this.socket;

    return {
      send: (data: string) => socket.send(data),
      close: (code?: number, reason?: string) => socket.close(code, reason),
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      on: ((event: SocketEvent, handler: (...args: unknown[]) => void) => {
        if (event === "message") {
          socket.on("message", handler as (data: string | Buffer) => void);
          if (!this.replayed && !this.closedOrErrored) {
            this.replayed = true;
            for (const message of this.bufferedMessages) {
              handler(message);
            }
            this.bufferedMessages.length = 0;
            this.buffering = false;
          }
          return;
        }

        if (event === "close") {
          socket.on("close", handler as () => void);
          return;
        }

        if (event === "error") {
          socket.on("error", handler as (err: Error) => void);
        }
      }) as BufferedSocketLike["on"],
    };
  }
}
