// Bar Games (BARGAMES.md): standalone stays standalone; on a (fake) box the commands, status,
// events, results and hosting from the box work.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { DEFAULT_GAME_NAME } from "@thisorthat/shared";
import { fakeCore, sleep, startServer, setupRoom } from "../harness.mjs";

const TOKEN = "test-token";

describe("standalone (no BG_* env)", () => {
  let server;
  before(async () => {
    server = await startServer({ BG_CORE_URL: "", BG_GAME_TOKEN: "", BG_GAME_ID: "" });
  });
  after(() => server.stop());

  test("the game's own name, and venue.json says standalone", async () => {
    assert.deepEqual(await (await fetch(`${server.url}/api/config`)).json(), { gameName: DEFAULT_GAME_NAME });
    const venue = await (await fetch(`${server.url}/__bargames/venue.json`)).json();
    assert.equal(venue.standalone, true);
  });

  test("GAME_NAME still wins standalone", async () => {
    const named = await startServer({ GAME_NAME: "Friday Picks" });
    try {
      assert.equal((await (await fetch(`${named.url}/api/config`)).json()).gameName, "Friday Picks");
    } finally {
      await named.stop();
    }
  });
});

describe("on a box", () => {
  let server, core;
  before(async () => {
    core = await fakeCore(TOKEN);
    server = await startServer({ BG_GAME_ID: "thisorthat", BG_CORE_URL: core.url, BG_GAME_TOKEN: TOKEN, ALL_VOTED_GRACE_MS: "50" });
  });
  after(async () => {
    await server.stop();
    await core.close();
  });

  const cmd = async (command, roomCode, args) => {
    const res = await fetch(`${server.url}/__bargames/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ command, roomCode, args }),
    });
    return res.json();
  };
  const status = async () => (await (await fetch(`${server.url}/__bargames/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).rooms;
  const statusOf = async (code) => (await status()).find((r) => r.code === code);

  test("the venue's name for the game", async () => {
    assert.equal((await (await fetch(`${server.url}/api/config`)).json()).gameName, "This or That at Test Bar");
  });

  test("create_room: a venue room, its TV route, driven by start / next_round / end", async () => {
    const made = await cmd("create_room", undefined, { kind: "venue", title: "Friday" });
    assert.equal(made.ok, true);
    const code = made.data.roomCode;
    assert.match(made.data.hostUrl, new RegExp(`^/join/${code}\\?host=`));
    const s = await statusOf(code);
    assert.equal(s.kind, "venue");
    assert.equal(s.phase, "lobby");
    assert.equal(s.joinPath, `/join/${code}`);
    assert.match(s.title, /^Friday · Lobby/);
    await core.waitFor((e) => e.type === "room_created" && e.roomCode === code, "room_created");

    const tv = await server.client();
    await tv.ok("joinRoom", { code, role: "table" });
    const ann = await server.client();
    await ann.ok("joinRoom", { code, role: "player", name: "Ann" });
    const bo = await server.client();
    await bo.ok("joinRoom", { code, role: "player", name: "Bo" });
    assert.equal(ann.state.you.role, "player", "no first-joiner offer: a plain player");

    assert.equal((await cmd("next_round", code)).ok, false, "not started");
    assert.equal((await cmd("start", code)).ok, true);
    assert.match((await cmd("start", code)).message, /already started/);
    const started = await core.waitFor((e) => e.type === "round_started" && e.roomCode === code, "round_started");
    assert.equal(started.data.round, 1);
    assert.match(started.data.question, / or .*\?$/);
    assert.equal((await statusOf(code)).phase, "question");
    assert.equal((await statusOf(code)).tables, 1);

    await ann.ok("vote", "a");
    await bo.ok("vote", "a");
    await tv.waitFor((s) => s.phase === "reveal");
    const ended = await core.waitFor((e) => e.type === "round_ended" && e.roomCode === code, "round_ended");
    assert.deepEqual([ended.data.a, ended.data.b, ended.data.votes, ended.data.majority], [2, 0, 2, "a"]);

    // next_round while voting reveals now; after a reveal it asks the next question.
    assert.equal((await cmd("next_round", code)).ok, true);
    await tv.waitFor((s) => s.phase === "question" && s.round === 2);
    assert.equal((await cmd("next_round", code)).ok, true);
    await tv.waitFor((s) => s.phase === "reveal" && s.round === 2);

    assert.equal((await cmd("end", code)).ok, true);
    await core.waitFor((e) => e.type === "game_over" && e.roomCode === code, "game_over on end");
    const closed = await core.waitFor((e) => e.type === "room_closed" && e.roomCode === code, "room_closed");
    assert.equal(closed.data.reason, "host");
    assert.equal(await statusOf(code), undefined, "gone from status");
    assert.match(ann.closedReason, /host ended/);
    assert.equal(core.of("winner", code).length, 0, "no winner without scoring");
    assert.equal(core.results.filter((r) => r.roomCode === code).length, 0, "no results without scoring");
  });

  test("unknown room and wrong state", async () => {
    for (const c of ["start", "next_round", "end", "host_link", "cohost_link"]) {
      const r = await cmd(c, "ZZZZ");
      assert.equal(r.ok, false, c);
      assert.equal(r.message, "no such room");
    }
    const { code, host } = await setupRoom(server, ["Ann"]);
    await host.ok("start");
    await host.ok("endGame");
    assert.match((await cmd("start", code)).message, /game is over/);
    assert.equal((await cmd("next_round", code)).ok, true, "next_round from the end screen plays again");
    await host.waitFor((s) => s.phase === "question");
  });

  test("scoring on: winner, game_over with winners, and results for the leaderboards", async () => {
    const { code, host, players } = await setupRoom(server, ["Ann", "Bo", "Cy"]);
    const [ann, bo, cy] = players;
    await host.ok("updateSettings", { scoring: true, rounds: 2 });
    await host.ok("start");
    for (const [a, b, c] of [
      ["a", "a", "b"],
      ["b", "b", "b"],
    ]) {
      await ann.waitFor((s) => s.phase === "question");
      await ann.ok("vote", a);
      await bo.ok("vote", b);
      await cy.ok("vote", c);
      await host.waitFor((s) => s.phase === "reveal");
      await host.ok("next");
    }
    await host.waitFor((s) => s.phase === "over");
    const over = await core.waitFor((e) => e.type === "game_over" && e.roomCode === code, "game_over");
    assert.deepEqual(over.data.winners.sort(), ["Ann", "Bo"]);
    assert.deepEqual(over.data.rounds, 2);
    const winners = core.of("winner", code).map((e) => [e.data.name, e.data.score]);
    assert.deepEqual(winners.sort(), [
      ["Ann", 2],
      ["Bo", 2],
    ]);
    await sleep(200);
    const res = core.results.find((r) => r.roomCode === code);
    assert.ok(res, "reportResults");
    assert.deepEqual(
      res.results.map((r) => [r.player.name, r.place, r.score]).sort(),
      [
        ["Ann", 1, 2],
        ["Bo", 1, 2],
        ["Cy", 3, 1],
      ],
    );
  });

  test("ties: one winner: a single winner event with the tiebreak, places 1, 2, 3 in the results", async () => {
    const { code, host, players } = await setupRoom(server, ["Ann", "Bo", "Cy"]);
    await host.ok("updateSettings", { scoring: true, ties: "one", rounds: 4 });
    await host.ok("start");
    for (const votes of [
      ["a", "a", "b"],
      ["a", "a", "b"],
      ["a", "b", "a"],
      ["a", "b", "b"],
    ]) {
      await players[0].waitFor((s) => s.phase === "question");
      for (let i = 0; i < 3; i++) await players[i].ok("vote", votes[i]);
      await host.waitFor((s) => s.phase === "reveal");
      await host.ok("next");
    }
    const over = await core.waitFor((e) => e.type === "game_over" && e.roomCode === code, "game_over");
    assert.deepEqual(over.data.winners, ["Ann"]);
    assert.deepEqual(
      core.of("winner", code).map((e) => e.data),
      [{ name: "Ann", score: 3, tiebreak: "streak" }],
    );
    await sleep(200);
    const res = core.results.find((r) => r.roomCode === code);
    assert.deepEqual(
      res.results.map((r) => [r.player.name, r.place, r.score]),
      [
        ["Ann", 1, 3],
        ["Bo", 2, 3],
        ["Cy", 3, 2],
      ],
    );
  });

  test("first joiner hosts, and the offer closes when staff open the host link first", async () => {
    const made = await cmd("create_room", undefined, { kind: "venue", firstJoinerHosts: true });
    const code = made.data.roomCode;
    const first = await server.client();
    const joined = await first.ok("joinRoom", { code, role: "player", name: "Ann" });
    assert.equal(joined.role, "host");
    const second = await server.client();
    assert.equal((await second.ok("joinRoom", { code, role: "player", name: "Bo" })).role, "player");
    assert.equal((await cmd("start", code)).ok, true);

    // Staff open the host link before anyone joins: the next phone is a player.
    const made2 = await cmd("create_room", undefined, { kind: "venue", firstJoinerHosts: true });
    const key = new URL(made2.data.hostUrl, "http://x").searchParams.get("host");
    const staff = await server.client();
    assert.equal((await staff.ok("resume", { code: made2.data.roomCode, token: key })).role, "host");
    const phone = await server.client();
    assert.equal((await phone.ok("joinRoom", { code: made2.data.roomCode, role: "player", name: "Cy" })).role, "player");
  });

  test("host_link takes over (the old host becomes a co-host); cohost_link is single use; remove_cohost", async () => {
    const { code, host, players } = await setupRoom(server, ["Ann"]);
    const link = await cmd("host_link", code);
    assert.equal(link.ok, true);
    const key = new URL(link.data.url, "http://x").searchParams.get("host");
    assert.equal((await host.waitFor((s) => s.you.role === "cohost")).you.role, "cohost");
    const staff = await server.client();
    assert.equal((await staff.ok("resume", { code, token: key })).role, "host");
    const link2 = await cmd("host_link", code);
    assert.notEqual(new URL(link2.data.url, "http://x").searchParams.get("host"), key, "a new key each time");
    assert.equal((await staff.emit("resume", { code, token: key })).ok, false, "the old key stops working");

    const inv = await cmd("cohost_link", code, { minutes: 5 });
    assert.equal(inv.ok, true);
    assert.ok(Date.parse(inv.data.expiresAt) > Date.now());
    const invite = new URL(inv.data.url, "http://x").searchParams.get("cohost");
    const ann = players[0];
    const promoted = await ann.ok("joinRoom", { code, role: "player", name: "Ann", token: ann.token, cohost: invite });
    assert.equal(promoted.role, "cohost");
    const other = await server.client();
    assert.match((await other.emit("joinRoom", { code, role: "player", name: "Eve", cohost: invite })).error, /already been used/);

    // A co-host runs the game but can't close the room or remove anyone.
    await ann.ok("start");
    assert.equal((await ann.emit("closeRoom")).ok, false);
    assert.equal((await ann.emit("kick", host.state.you.id)).ok, false);
    assert.equal((await cmd("remove_cohost", code, { memberId: promoted.memberId })).ok, true);
    assert.equal((await ann.waitFor((s) => s.you.role === "player")).you.role, "player");
    assert.equal((await cmd("remove_cohost", code, { memberId: promoted.memberId })).ok, false);
  });

  test("failed joins are limited per guest (the gateway's client IP), not per gateway", async () => {
    const failJoins = async (ip, n) => {
      const s = io(server.url, { transports: ["websocket"], forceNew: true, reconnection: false, extraHeaders: { "x-bargames-via": "1", "x-bargames-client-ip": ip } });
      await new Promise((r, j) => (s.once("connect", r), s.once("connect_error", j)));
      let last;
      for (let i = 0; i < n; i++) last = await new Promise((r) => s.emit("joinRoom", { code: "QQQQ", role: "player", name: "x" }, r));
      s.close();
      return last.error;
    };
    assert.match(await failJoins("192.168.1.50", 21), /Too many attempts/);
    assert.match(await failJoins("192.168.1.51", 1), /no room/, "another guest behind the same gateway still gets in");
  });

  test("players_changed is debounced; host Close room sends room_closed", async () => {
    const { code, host } = await setupRoom(server, ["Ann", "Bo"]);
    const ev = await core.waitFor((e) => e.type === "players_changed" && e.roomCode === code, "players_changed", 6000);
    assert.equal(ev.data.players, 2);
    await host.ok("closeRoom");
    const closed = await core.waitFor((e) => e.type === "room_closed" && e.roomCode === code, "closed");
    assert.equal(closed.data.reason, "host");
  });
});
