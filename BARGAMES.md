# This or That on a Bar Games box

**Report for the Bar Games side.** Guide followed:
`C:\CodeProjects\GameBroker\integration\README.md` (SDK 0.15.0, game kit 0.8.0).

| | |
|---|---|
| Manifest | [bargames.json](bargames.json): `id: "thisorthat"`, port 3012, SDK level 3, `routing.basePath: true` |
| Image | `ghcr.io/thezigpc/thisorthat:0.1.0` (tag = `version`) |
| SDK / kit | `vendor/bargames-sdk-0.15.0.tgz`, `vendor/bargames-gamekit-0.8.0.tgz` |
| Level reached | **3** (branded, connected, controllable) |

## `npx bargames check`

Run against the mock box under `/thisorthat` (`mock-box . --base /thisorthat --port 7312
--core-port 7412`, game on 3012 with the env vars it printed):

```
✓ health /health → 200
✓ /__bargames/venue.json returns the box's branding ("This or That (mock)")
✓ /__bargames/theme.css served
✓ "room_closed" declared (the box takes a closed room off the TVs at once)
✓ status refuses requests without the game token
✓ status → 0 room(s)
✓ unknown commands are rejected
✓ command "start" is wired (and refuses a missing room)
✓ command "next_round" is wired (and refuses a missing room)
✓ command "end" is wired (and refuses a missing room)
✓ command "host_link" is wired (and refuses a missing room)
✓ command "cohost_link" is wired (and refuses a missing room)
✓ command "remove_cohost" is wired (and refuses a missing room)
✓ create_room → room BUFJ (with hostUrl)
✓ status lists BUFJ as a venue room
✓ table view /room/BUFJ?role=table → 200
✓ host_link answers a new host link each time (take-over)
✓ cohost_link answers single-use invites that expire
✓ end closes BUFJ
✓ BUFJ left status after "end"

all checks passed
```

`npx bargames validate .`: `✓ thisorthat@0.1.0 (sdk level 3)`, plus the expected "not pinned
by digest" warning.

## Events

`room_created`, `room_closed` and `players_changed` come from the kit's `wireBarGames`
(the registry's lifecycle, `players_changed` debounced 2 s, never for reconnects). The game's
own, all in [server/src/rooms/Room.ts](server/src/rooms/Room.ts):

| Event | Where | `data` |
|---|---|---|
| `round_started` | `askNext()`, line 439 | `{ round, question: "Beach or Mountains?" }` |
| `round_ended` | `reveal()`, line 491 | `{ round, question, a, b, votes, majority: "a" \| "b" \| "tie" \| null }` |
| `winner` | `finish()`, line 535, scoring on, once per player tied on the top score (> 0) | `{ name, score }` |
| `game_over` | `finish()`, line 536 | `{ rounds, winners? }` (`winners` only with scoring) |
| `game_result` | `bg.reportResults()`, line 541, scoring on and at least one question played | the SDK's `GameResult`: places are competition ranking (1, 1, 3), `score` = majority picks; only people who voted at least once |

A game ends (`finish()`) when the host or the box ends it, when the round limit is reached,
or when the packs run out. Closing a room mid-game (host Close room, the box's `end`, an
admin close) finishes the game first, so `game_over` and the results still go out
(`close()`, line 658). Idle closes, shutdowns and crashes don't.

Privacy: only names the players typed, and the question text.

## Commands

All through the kit's `wireBarGames` in [server/src/bargames.ts](server/src/bargames.ts). Each
runs the same `Room` method as the host's button, then broadcasts. A `GameError` becomes
`{ ok: false, message }` with the game's own words.

| Command | Room method | Refuses |
|---|---|---|
| `create_room` | `createVenueRoom()` ([registry.ts](server/src/rooms/registry.ts)): a `venue` room with an empty host seat "Venue", `hostUrl` `/join/{code}?host=<key>` | the room cap (`ROOM_FULL`) |
| `create_room` + `firstJoinerHosts` | the kit's `HostSeats({ firstJoinerHosts })`: the first phone to join takes the host seat under its own name. **Any** attach to the host seat (staff opening `hostUrl` first included) closes the offer | |
| `start` | `start()` (the host's Start) | already started; game over ("send next_round to play again"); no questions in the chosen packs |
| `next_round` | `next()` (the host's Next): while voting it reveals now; after a reveal it asks the next question (or finishes at the round limit); on the end screen it starts a new game | not started yet ("send start first") |
| `end` | the kit closes the room with cause `host` and the host's message ("The host ended this room."); a game in progress finishes first | unknown room |
| `host_link` | `HostSeats.takeover()` + `Room.takeOver()`: a new host key; the old host's phone stays on as a co-host and is told so | unknown room |
| `cohost_link` `{ minutes? }` | `HostSeats.invite()`: single-use, expiring `/join/{code}?cohost=<token>` | unknown room |
| `remove_cohost` `{ memberId }` | `Room.demoteCohost()`: a player again, told so | not a co-host |

No `pause` / `resume`: a question lasts a few seconds, and Next waits for the host anyway
(unless the room's "Next by itself" setting is on).

**Co-hosts** (role `cohost`) run the game and its settings: start, next, reveal, skip, end
game, ask their own questions. They can't close the room, remove players or invite co-hosts.
The host's phone has "Add a co-host" (a QR) and the co-host list.

**Status** is the kit's `overviews()`: `phase` (`lobby`, `question`, `reveal`, `over`),
`round`, `hostConnected`, `hostName`, `tables`, `maxPlayers` (150), times, `joinPath`
`/join/{code}` (never for private rooms) and a `title` such as
`Friday · Question 3: Beach or Mountains?`.

## Table route: `/room/{code}?role=table`

The URL alone joins as a TV (`joinRoom { role: "table" }`), retrying every 10 s if the room
isn't there. On a box it runs `tableMode` (no pointer, wake lock, `--bg-safe-x/y`,
reconnecting / room closed banner, shared-screen mark).

| Step 7 item | Result |
|---|---|
| The URL alone joins, no prompt or gesture | ✓ |
| Nothing depends on audio | ✓ (no audio at all) |
| Fills 1920×1080, no scrolling, text ≥ 3vh, safe margins | ✓ checked in Chromium at 1920×1080 in every phase (lobby, question with and without pictures, reveal, scored reveal, end screen): no scroll, nothing outside the screen, the join corner covers nothing |
| Recovers from a dropped socket or a restart | ✓ the kit's `useRoomConnection` resumes on every connect; a room that's gone shows "Room closed" (and the box clears the TV) |
| Light on animation | ✓ the split bar slides once per reveal, the winner card wiggles once, the countdown ring ticks 5×/s while voting; `prefers-reduced-motion` turns them off |
| Nothing assumes a pointer | ✓ no controls on a box TV (⛶ is hidden there) |

What it shows: the question and both sides (pictures when there are any), the countdown, the
split bar (live while voting unless scoring is on: then "N of M voted" and the split stays
secret until the reveal, so nobody follows the crowd), the reveal (winner card, percentages,
a line such as "Landslide! Tacos wins big."), the top 5 when scoring, and an end screen
(scoreboard, or "most divisive" / "most agreed"). The join QR and short link (`joinDisplay`'s
`roomShort`, else `short`, through the kit's `JoinAddress`) are big in the lobby and in a
corner during play. The venue's theme colors the chrome; the two sides keep their own colors
(they carry meaning). The staff announcement shows on TVs when its `show` allows it.

## Branding and the venue

- `--venue-*` variables on all chrome, with the game's own colors as fallbacks.
- `/api/config` gives the venue's name for the game on a box, `GAME_NAME` (default "This or
  That") otherwise.
- Venue logo next to the title on the TV, on a box.
- `<VenueAnnouncement>` on every page (phones and TVs; it follows `show` and `position`).
- `<BackToGames>` at the bottom of the landing page only.
- `/admin` (`routes.admin`): the kit's admin auth with `trusted: bg.isStaff`,
  `venuePassword: bg.checkVenuePassword`, `onBox: bg.connected`; `<BoxAdminLink>` at the top.

## Container

- Writes only under `DATA_DIR` (`/data` in the image): `admin.json` (password hash),
  `settings.json` (idle time, defaults for new rooms), `packs/<id>.json` (the venue's packs),
  `media/<name>` (uploaded pictures, png/jpeg/gif/webp checked by their first bytes, at most
  4 MB each and 300 in all). Pictures a host attaches to a live question stay in memory with
  the room (24 per room, 600 KB each).
- `USER node`, `/data` chowned to it. No outbound network from the server (https picture
  addresses in packs are loaded by the browsers).
- **Read-only test:** Docker isn't installed on the development PC, so `docker run --read-only`
  hasn't been run. The server writes nothing outside `DATA_DIR` (checked in code: `content.ts`,
  the kit's JSON store).

## Image

- `ghcr.io/thezigpc/thisorthat:0.1.0`, built by the "Publish image" workflow from a clean
  checkout of `main` (run 43668460063, green). The push-triggered run that followed
  (43668461040) skipped it as already published.
- The package is **public**: an anonymous manifest request answers `200`.

## Standalone

There is no earlier version: standalone is the game itself. Off a box (no `BG_*` env) the
SDK is inert (`emit`, `reportResults` no-ops, `watchVenue` never fires), `/__bargames/venue.json`
says `standalone: true` and `/api/config` returns `GAME_NAME` (tests in
`test/specs/05-bargames.test.mjs`). The same browser flow ran standalone at the root and
behind the mock box under `/thisorthat` with no console errors and no failed requests.

## Tests

`npm test`: 34 tests (node:test, a throwaway server per spec): pack parsing, the game flow
(votes, the split's visibility, scoring, ties, streaks, skip, the round limit, auto-next),
reconnects, live questions with pictures (and refused fake pictures), the admin (setup, packs,
pictures, persistence, closing rooms), and the box (standalone, `create_room`, every command
with good / unknown room / wrong state, events, results, first joiner hosts, take-over,
co-host invites, `players_changed`, the gateway's client IP for rate limits).

## SDK requests

None blocking. Small ones:
- **`next_round` meaning for quick-fire games.** "Next round" here means "reveal now" while
  voting and "next question" after a reveal. A standard `reveal` command (or a documented
  convention) would let the box's iPad show the right button label.
- **Results for games where everyone can tie.** Guess the majority often ends in a big tie
  for first. It'd help to know whether the box's "Tonight's winners" wants every player tied on
  place 1, or a cap.
