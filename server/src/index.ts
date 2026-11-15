import { createServer } from "http";
import { existsSync } from "fs";
import express from "express";
import { Server } from "socket.io";
import { DEFAULT_GAME_NAME } from "@thisorthat/shared";
import { installShutdown, log, serveSpa, SOCKET_SERVER_OPTIONS } from "@bargames/gamekit/server";
import { CLIENT_DIST_PATH, PORT } from "./config.js";
import { initContent, MIME_BY_EXT, mediaFile } from "./content.js";
import { createRooms } from "./rooms/registry.js";
import { MAX_ROOM_IMAGE_BYTES } from "./rooms/Room.js";
import { adminAuth, adminRouter, uploadRouter } from "./admin/routes.js";
import { initAdminSettings } from "./admin/settings.js";
import { registerSocketHandlers, type IO } from "./socket/index.js";
import { bg, displayName, registerBarGames } from "./bargames.js";

await initContent();
await initAdminSettings();
await adminAuth.init();

const app = express();
app.disable("x-powered-by");
const httpServer = createServer(app);
const io: IO = new Server(httpServer, {
  ...SOCKET_SERVER_OPTIONS,
  // A live question can carry two phone pictures (resized on the phone, 600 KB each at most).
  maxHttpBufferSize: Math.ceil(MAX_ROOM_IMAGE_BYTES * 2 * 1.4) + 64 * 1024,
});

const rooms = createRooms({
  sendState: (socketId, view) => io.to(socketId).emit("state", view),
  sendClosed: (socketId, reason) => io.to(socketId).emit("closed", { reason }),
  sendNotice: (socketId, message) => io.to(socketId).emit("notice", { message }),
});

// Bar Games: /__bargames/* (venue.json, theme.css, command, status). Before the SPA
// catch-all, which would otherwise swallow those paths.
app.use(bg.middleware());
registerBarGames(rooms);

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});
app.use("/api/admin/upload", uploadRouter());
app.use("/api/admin", adminRouter(rooms));
app.get("/api/config", async (_req, res) => {
  res.json({ gameName: await displayName(process.env.GAME_NAME || DEFAULT_GAME_NAME) });
});

// Pictures. Only files whose first bytes are png/jpeg/gif/webp were ever saved, and they
// go out with that type and nosniff (never SVG: no scripts in pictures).
const imageHeaders = (res: express.Response, mime: string) => {
  res.set({ "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'", "Cache-Control": "public, max-age=3600" });
};
app.get("/media/room/:code/:id", (req, res) => {
  const img = rooms.get(String(req.params.code))?.images.get(String(req.params.id));
  if (!img) return void res.status(404).end();
  imageHeaders(res, img.mime);
  res.end(img.data);
});
app.get("/media/:name", (req, res) => {
  const file = mediaFile(String(req.params.name));
  if (!file || !existsSync(file)) return void res.status(404).end();
  imageHeaders(res, MIME_BY_EXT[file.split(".").pop() ?? ""] ?? "application/octet-stream");
  res.sendFile(file);
});

if (existsSync(CLIENT_DIST_PATH)) {
  // The built client. Under a path prefix (BG_BASE_PATH on a box, BASE_PATH behind your own
  // proxy) index.html gets <meta name="bargames-base"> and <base href>.
  serveSpa(app, { dist: CLIENT_DIST_PATH, skip: ["/api", "/socket.io", "/__bargames", "/health", "/media"] });
} else {
  log.warn("boot", "client build not found; serving API only", { path: CLIENT_DIST_PATH });
}

registerSocketHandlers(io, rooms);

httpServer.listen(PORT, () => {
  log.info("boot", "listening", { port: PORT });
});

installShutdown(rooms, {
  restartReason: "The server is restarting for an update. Please rejoin in a minute.",
  crashReason: "The server hit an unexpected error and had to restart. Please rejoin in a minute.",
  drainMs: 500,
  flush: () => bg.flush(),
  beforeExit: () => void io.close(),
});
