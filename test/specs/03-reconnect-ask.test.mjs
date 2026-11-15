// Reconnects keep the seat and the vote; the host's live questions, with phone pictures.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, setupRoom } from "../harness.mjs";

let server;
before(async () => {
  server = await startServer({ ALL_VOTED_GRACE_MS: "50" });
});
after(() => server.stop());

// A 1x1 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("resume on a new socket keeps the seat, the name and the vote", async () => {
  const { code, host, players } = await setupRoom(server, ["Ann", "Bo"]);
  await host.ok("start");
  await players[0].waitFor((s) => s.phase === "question");
  await players[0].ok("vote", "a");
  players[0].socket.close();
  const again = await server.client();
  const res = await again.ok("resume", { code, token: players[0].token });
  assert.equal(res.name, "Ann");
  const v = await again.waitFor((s) => s.phase === "question");
  assert.equal(v.you.choice, "a");
  assert.equal((await again.emit("resume", { code, token: "nope" })).ok, false);
  // Same token on joinRoom: the same seat, never a second one.
  await again.ok("joinRoom", { code, role: "player", name: "Ann again", token: players[0].token });
  assert.equal((await host.waitFor((s) => s.players.length === 2)).players.length, 2);
});

test("names: required and unique", async () => {
  const { code } = await setupRoom(server, ["Ann"]);
  const c = await server.client();
  assert.match((await c.emit("joinRoom", { code, role: "player", name: "  " })).error, /Enter your name/);
  assert.match((await c.emit("joinRoom", { code, role: "player", name: "ann" })).error, /already has that name/);
  assert.match((await c.emit("joinRoom", { code: "ZZZZ", role: "player", name: "X" })).error, /no room/);
});

test("ask: a typed question goes up now between questions, next while voting", async () => {
  const { host, players } = await setupRoom(server, ["Ann"]);
  assert.match((await host.emit("ask", { a: "", b: "x" })).error, /both sides/);
  assert.equal((await players[0].emit("ask", { a: "x", b: "y" })).ok, false, "players can't");
  const now = await host.ok("ask", { a: "Tacos", b: "Burritos", prompt: "Lunch:" });
  assert.equal(now.now, true, "from the lobby it starts the game with it");
  const q = await players[0].waitFor((s) => s.phase === "question");
  assert.deepEqual([q.question.prompt, q.question.a.label, q.question.b.label], ["Lunch:", "Tacos", "Burritos"]);
  const next = await host.ok("ask", { a: "Sun", b: "Moon" });
  assert.equal(next.now, false);
  assert.equal((await host.waitFor((s) => s.queued === 1)).queued, 1);
  await players[0].ok("vote", "a");
  await host.waitFor((s) => s.phase === "reveal");
  await host.ok("next");
  const q2 = await host.waitFor((s) => s.phase === "question" && s.round === 2);
  assert.equal(q2.question.a.label, "Sun");
});

test("ask with pictures: stored in the room, served as images, bad ones refused", async () => {
  const { code, host, players } = await setupRoom(server, ["Ann"]);
  await host.ok("ask", { a: "Red", b: "Blue", aImage: PNG });
  const q = await players[0].waitFor((s) => s.phase === "question");
  assert.match(q.question.a.image, new RegExp(`^media/room/${code}/[0-9a-f]+$`));
  assert.equal(q.question.b.image, undefined);
  const res = await fetch(`${server.url}/${q.question.a.image}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  // Not a picture, an SVG, or a lie about the type: refused.
  for (const bad of ["data:text/html;base64,PGgxPmhpPC9oMT4=", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "data:image/png;base64,aGVsbG8gd29ybGQ="]) {
    assert.match((await host.emit("ask", { a: "x", b: "y", bImage: bad })).error, /picture couldn't be used/);
  }
  assert.equal((await fetch(`${server.url}/media/room/${code}/nope`)).status, 404);
});
