# This or That

A quick filler game for the Bar Games box that also runs on its own: the host fires two-way
questions, everyone votes on a phone within seconds, the TV shows the room's split live with
a playful reveal. Optional scoring ("guess the majority") and streaks. Brief: `BRIEF.md`.
Box report and reference: [BARGAMES.md](BARGAMES.md).

## Layout

npm workspaces, the shape of `C:\CodeProjects\BingoDigitalGame` (the pattern this copies;
don't edit it):
- `shared/src/protocol.ts`: views, settings (`sanitizeSettings`, the single validator), errors.
  `samplePack.ts`: the built-in pack (original; don't paste published question lists).
  `packs.ts`: CSV/JSON pack parsing (pure).
- `server/src/rooms/Room.ts`: the state machine `lobby → question → reveal → … → over`.
  Timers go through the kit's `safeTimeout`. Votes can change until voting closes; everyone
  connected voting reveals after `ALL_VOTED_GRACE_MS`. Scoring: a tie counts for both sides;
  not voting breaks a streak. The live split goes to TVs and hosts only while scoring is off.
- `server/src/content.ts`: the venue's packs (`DATA_DIR/packs`) and pictures
  (`DATA_DIR/media`, png/jpeg/gif/webp by magic bytes, never SVG). Live-question pictures
  stay in memory per room (`/media/room/<code>/<id>`).
- `server/src/bargames.ts`: the single SDK connection (kit `wireBarGames`, `HostSeats`).
- `server/src/admin/`: kit admin auth; uploads have their own router (`/api/admin/upload`)
  because the kit's JSON parser stops at 16 KB.
- `client/`: React + Vite. `RoomPage` picks `HostView` / `PlayerView` / `TableView` by role;
  `?role=table` joins as a TV with no prompt. The host can show the TV view on their own
  screen (📺) with controls.

## Rules

- **Standalone must behave the same with or without the SDK.** Box-only behavior goes behind
  `bg.connected` / `isOnBox(ctx)`.
- Commands run the same `Room` method as the host's button, then broadcast.
- Never write a bare `"/api/…"`: use `serverUrl` / `mediaUrl` (path prefix under a box).
  Storage keys start with `thisorthat_`.
- The two side colors (`--side-a`, `--side-b`) carry meaning: don't map venue colors onto them.
- Releases: bump `version` and the `image` tag in `bargames.json` together; never re-publish a tag.
- Don't edit GameBroker, GameKit or other modules; platform needs go to the GameBroker session
  as "SDK requests".

## Testing

- `npm run build && npm test` (each spec spawns its own server on a free port).
- Mock box: `npx bargames mock-box . --base /thisorthat --port 7312 --core-port 7412 --game http://127.0.0.1:3012`
  from PowerShell (Git Bash mangles `/thisorthat`), then start the server with the env it
  prints and `npx bargames check . --game http://127.0.0.1:3012 --core-port 7412`.
- Several sessions share this PC: check ports are free first, and stop only the PIDs on your
  own ports (never by process name).
