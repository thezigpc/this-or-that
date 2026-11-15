# This or That

A quick party filler between bigger games. The host fires two-way questions ("Beach or
mountains?", "Tea or kava?"), everyone votes on their phone in a few seconds, and the TV shows
how the room split, with a playful reveal. About five minutes, no scores needed.

- **Optional scoring:** "guess the majority", a point for picking what most people picked
  (ties count for both sides). The split stays hidden until the reveal while it's on.
- **Optional streaks:** 🔥 for picking with the majority several times in a row.
- **Questions:** an original sample pack, the venue's own packs (CSV or JSON, uploaded on
  `/admin`), and questions the host types live. Each side can be a picture.
- **Phones:** two big buttons, a countdown, and "You picked Tacos: 63% agreed".
- **TV:** the question, both sides, a live split bar, the reveal, the join QR and short link.
- **Host:** start, next question, reveal now, skip, end game; the voting time, questions per
  game, scoring, streaks, "next by itself", and which packs. Co-hosts can help run it.

It runs on its own, or on a [Bar Games](https://github.com/thezigpc/venueplay) venue box
(see [BARGAMES.md](BARGAMES.md)).

## Running it

```bash
npm install
npm run dev        # server on :3012, client on :5180
npm run build && npm test
npm run build && node server/dist/index.js   # production: http://localhost:3012
```

Or with Docker: `docker compose up -d --build`.

| Env var | Default | |
|---|---|---|
| `PORT` | `3012` | |
| `GAME_NAME` | `This or That` | the name on every screen |
| `DATA_DIR` | `./data` | admin password hash, settings, packs, pictures |
| `ADMIN_PASSWORD` | (unset) | otherwise set on `/admin` the first time |
| `BASE_PATH` | (unset) | serve under a path behind your own proxy, e.g. `/thisorthat` |
| `ROOM_IDLE_MINUTES` | `120` | until changed on `/admin` |

## Pages

- `/`: join a room, or host one (from your phone, or on a big screen with the controls on it).
- `/join/ABCD`: the join form with the code filled in (what the QR code opens).
- `/room/ABCD?role=table`: the TV view for room ABCD, no tapping needed.
- `/admin`: rooms, defaults for new rooms, packs and pictures.

## Packs

CSV with a header row:

```csv
this,that,prompt,this_image,that_image
Beach,Mountains,,beach.jpg,https://example.com/mountains.jpg
Tea,Kava,Tonight:,,
```

Without a header the columns are this, that, this image, that image. Commas, semicolons or tabs.
JSON: a list of `{ "this": "Beach", "that": "Mountains", "prompt"?, "thisImage"?, "thatImage"? }`,
or `{ "name": "…", "questions": [...] }`. A picture is the name of one uploaded on `/admin`
(upload them first), or an `https://` address. See [examples/](examples/).

## Layout

npm workspaces: `shared/` (protocol, the sample pack, pack parsing), `server/` (Express +
Socket.IO, server-authoritative rooms), `client/` (React + Vite), `test/` (node:test).
