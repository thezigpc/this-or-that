import { io, type Socket } from "socket.io-client";
import { createCall, serverBase, serverOrigin, socketPath, SOCKET_OPTIONS } from "@bargames/gamekit/client";

// In dev, Vite serves the client on :5180 while the server runs on :3012. In production the
// server serves the built client itself (one origin). Under a path prefix (a box's
// https://<venue>/thisorthat/) `serverUrl` carries it; socket.io takes the bare origin plus
// a `path` (a URL's path would be read as a namespace).
const dev = { vitePort: 5180, serverPort: 3012 };
export const serverUrl = serverBase(dev);

// WebSocket first (the kit's SOCKET_OPTIONS): long-polling first lost early emits through
// Cloudflare Tunnel in the sibling games.
export const socket: Socket = io(serverOrigin(dev), { ...SOCKET_OPTIONS, path: socketPath() });

const kitCall = createCall(socket as unknown as Parameters<typeof createCall>[0]);

/** Emit with an ack as a promise. Rejects with the server's error message. */
export function call<T = object>(event: string, ...args: unknown[]): Promise<T> {
  return kitCall<T>(event, ...args);
}

/** The same with longer to answer: a live question with pictures. */
export const slowCall = kitCall.withTimeout(30_000);

/** An image path from the server ("media/…") as a URL; https URLs as they are. */
export const mediaUrl = (src: string): string => (/^https:\/\//i.test(src) ? src : `${serverUrl}/${src.replace(/^\/+/, "")}`);
