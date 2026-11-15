import path from "path";
import { createJsonStore } from "@bargames/gamekit/server";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const PORT = num("PORT", 3012);
/** Built client, served by this process in production (one origin). */
export const CLIENT_DIST_PATH = process.env.CLIENT_DIST_PATH ?? path.resolve(here, "../../client/dist");
/** Persisted state: admin password hash, settings, the venue's packs and pictures. */
export const DATA_DIR = process.env.DATA_DIR ?? path.resolve(here, "../../data");
export const store = createJsonStore(DATA_DIR);
export const DEFAULT_ROOM_IDLE_MINUTES = num("ROOM_IDLE_MINUTES", 120);
export const ROOM_SWEEP_INTERVAL_MS = num("ROOM_SWEEP_INTERVAL_MS", 60 * 1000);
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
export const MAX_ROOMS = num("MAX_ROOMS", 200);
export const MAX_PLAYERS_PER_ROOM = num("MAX_PLAYERS_PER_ROOM", 150);
export const MAX_TABLES_PER_ROOM = num("MAX_TABLES_PER_ROOM", 6);
/** After the last vote of everyone connected, wait this long before revealing. */
export const ALL_VOTED_GRACE_MS = num("ALL_VOTED_GRACE_MS", 800);
