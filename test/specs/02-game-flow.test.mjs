// The game over real sockets: lobby → question → reveal → … → over, votes, the split,
// scoring and streaks, skip, the round limit, play again.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startServer, setupRoom } from "../harness.mjs";

let server;
before(async () => {
  server = await startServer({ ALL_VOTED_GRACE_MS: "50" });
});
after(() => server.stop());

const question = (c) => c.waitFor((s) => s.phase === "question", "question");
const reveal = (c) => c.waitFor((s) => s.phase === "reveal", "reveal");

describe("a game", () => {
  test("lobby: players listed, nothing to vote on yet", async () => {
    const { host, players } = await setupRoom(server, ["Ann", "Bo"]);
    const v = await host.waitFor((s) => s.players.length === 2);
    assert.equal(v.phase, "lobby");
    assert.ok(v.remaining >= 50, "the sample pack's questions are counted before the game starts");
    assert.deepEqual(v.players.map((p) => p.name), ["Ann", "Bo"]);
    assert.equal((await players[0].emit("vote", "a")).ok, false);
    assert.ok(v.packs.some((p) => p.id === "sample"), "the host sees the packs");
    assert.deepEqual(players[0].state.packs, [], "players don't");
  });

  test("vote, change your mind, everyone voted → reveal with 'agreed' percents", async () => {
    const { code, host, players } = await setupRoom(server, ["Ann", "Bo", "Cy"]);
    const tv = await server.client();
    await tv.ok("joinRoom", { code, role: "table" });
    await host.ok("start");
    const q = await question(players[0]);
    assert.equal(q.round, 1);
    assert.ok(q.question.a.label && q.question.b.label);
    assert.ok(q.endsAt > Date.now());
    await players[0].ok("vote", "b");
    await players[0].ok("vote", "a"); // changed
    await players[1].ok("vote", "a");
    // Live split: the TV and the host see it (scoring off), players don't.
    const live = await tv.waitFor((s) => s.votes === 2);
    assert.deepEqual(live.tally, { a: 2, b: 0, total: 2 });
    assert.equal(players[2].state.tally, undefined);
    assert.equal((await players[2].emit("vote", "c")).ok, false, "bad choice");
    await players[2].ok("vote", "b");
    const r = await reveal(players[0]);
    assert.deepEqual(r.result.tally, { a: 2, b: 1, total: 3 });
    assert.equal(r.result.majority, "a");
    assert.equal(r.you.choice, "a");
    assert.equal(r.you.agreed, 67);
    const cy = await reveal(players[2]);
    assert.equal(cy.you.agreed, 33);
    assert.equal(cy.you.scored, undefined, "no scoring");
    assert.equal((await players[0].emit("vote", "b")).ok, false, "voting closed");
  });

  test("the timer closes voting; nobody voting is fine", async () => {
    const { host, players } = await setupRoom(server, ["Ann"]);
    await host.ok("updateSettings", { timerSeconds: 3 });
    await host.ok("start");
    await question(players[0]);
    const r = await players[0].waitFor((s) => s.phase === "reveal", "timer reveal", 6000);
    assert.equal(r.result.majority, null);
    assert.equal(r.you.choice, undefined);
  });

  test("scoring and streaks: guess the majority, ties count for both, the split stays hidden", async () => {
    const { host, players } = await setupRoom(server, ["Ann", "Bo", "Cy"]);
    const [ann, bo, cy] = players;
    await host.ok("updateSettings", { scoring: true, streaks: true });
    await host.ok("start");
    const vote = async (a, b, c) => {
      await question(ann);
      await ann.ok("vote", a);
      await bo.ok("vote", b);
      assert.equal(host.state.tally, undefined, "hidden while scoring");
      await cy.ok("vote", c);
      return reveal(ann);
    };
    let r = await vote("a", "a", "b");
    assert.equal(r.you.scored, true);
    assert.equal((await reveal(cy)).you.scored, false);
    await host.ok("next");
    r = await vote("b", "b", "a");
    assert.equal(r.you.streak, 2);
    const board = r.players.map((p) => [p.name, p.score]);
    assert.deepEqual(board, [
      ["Ann", 2],
      ["Bo", 2],
      ["Cy", 0],
    ]);
    await host.ok("next");
    // Bo doesn't vote: a 1-1 tie, both sides right; Bo's streak breaks.
    await question(ann);
    await ann.ok("vote", "a");
    await cy.ok("vote", "b");
    await host.ok("reveal");
    r = await reveal(ann);
    assert.equal(r.result.majority, "tie");
    assert.equal(r.you.scored, true);
    const lines = Object.fromEntries(r.players.map((p) => [p.name, p]));
    assert.equal(lines.Ann.score, 3);
    assert.equal(lines.Ann.streak, 3);
    assert.equal(lines.Bo.streak, 0);
    assert.equal(lines.Bo.bestStreak, 2);
    assert.equal(lines.Cy.score, 1);
  });

  // Ann and Bo both end on 3; Ann's best streak is 3, Bo's 2; Cy has 2.
  const TIE_ROUNDS = [
    ["a", "a", "b"],
    ["a", "a", "b"],
    ["a", "b", "a"],
    ["a", "b", "b"],
  ];
  const playTieGame = async (ties) => {
    const { host, players } = await setupRoom(server, ["Ann", "Bo", "Cy"]);
    await host.ok("updateSettings", { scoring: true, ties, rounds: TIE_ROUNDS.length });
    await host.ok("start");
    for (const votes of TIE_ROUNDS) {
      await players[0].waitFor((s) => s.phase === "question");
      for (let i = 0; i < 3; i++) await players[i].ok("vote", votes[i]);
      await host.waitFor((s) => s.phase === "reveal");
      await host.ok("next");
    }
    return { host, players, over: await host.waitFor((s) => s.phase === "over", "over") };
  };
  const ids = (view) => Object.fromEntries(view.players.map((p) => [p.name, p.id]));

  test("ties: everyone tied wins (the default)", async () => {
    const { over, players } = await playTieGame("share");
    assert.deepEqual(over.players.map((p) => [p.name, p.score, p.place]), [
      ["Ann", 3, 1],
      ["Bo", 3, 1],
      ["Cy", 2, 3],
    ]);
    assert.deepEqual(over.outcome.winners.sort(), [ids(over).Ann, ids(over).Bo].sort());
    assert.equal(over.outcome.tiebreak, undefined);
    assert.deepEqual((await players[1].waitFor((s) => s.phase === "over")).outcome.winners.length, 2);
  });

  test("ties: one winner, by the longest streak", async () => {
    const { over } = await playTieGame("one");
    assert.deepEqual(over.players.map((p) => [p.name, p.place]), [
      ["Ann", 1],
      ["Bo", 2],
      ["Cy", 3],
    ]);
    assert.deepEqual(over.outcome, { winners: [ids(over).Ann], tiebreak: "streak" });
  });

  test("ties: one winner, by the fastest votes when the streaks match", async () => {
    const { host, players } = await setupRoom(server, ["Ann", "Bo"]);
    await host.ok("updateSettings", { scoring: true, ties: "one", rounds: 1, timerSeconds: 5 });
    await host.ok("start");
    await players[1].waitFor((s) => s.phase === "question");
    await players[1].ok("vote", "a");
    await new Promise((r) => setTimeout(r, 300));
    await players[0].ok("vote", "a"); // Ann is slower
    await host.waitFor((s) => s.phase === "reveal");
    await host.ok("next");
    const over = await host.waitFor((s) => s.phase === "over");
    assert.deepEqual(over.outcome, { winners: [ids(over).Bo], tiebreak: "speed" });
    assert.deepEqual(over.players.map((p) => [p.name, p.place]), [
      ["Bo", 1],
      ["Ann", 2],
    ]);
  });

  test("skip drops the question without counting it; the round limit ends the game", async () => {
    const { host, players } = await setupRoom(server, ["Ann"]);
    await host.ok("updateSettings", { rounds: 2 });
    await host.ok("start");
    const first = await question(host);
    await host.ok("skip");
    const second = await host.waitFor((s) => s.phase === "question" && s.question.id !== first.question.id, "skipped");
    assert.equal(second.round, 1, "a skipped question isn't counted");
    await players[0].ok("vote", "a");
    await reveal(host);
    await host.ok("next");
    await host.waitFor((s) => s.phase === "question" && s.round === 2);
    await host.ok("reveal");
    await reveal(host);
    await host.ok("next");
    const over = await host.waitFor((s) => s.phase === "over", "over");
    assert.equal(over.history.length, 2);
    // Play again: a new game, new questions first.
    await host.ok("start");
    const again = await question(host);
    assert.equal(again.round, 1);
    const asked = new Set(over.history.map((h) => h.question.id));
    assert.equal(asked.has(again.question.id), false);
  });

  test("end game mid-vote, and only runners run the game", async () => {
    const { host, players } = await setupRoom(server, ["Ann"]);
    for (const ev of ["start", "next", "skip", "reveal", "endGame", "updateSettings"]) {
      const res = await players[0].emit(ev, {});
      assert.equal(res.ok, false, ev);
    }
    await host.ok("start");
    await question(host);
    await host.ok("endGame");
    const over = await host.waitFor((s) => s.phase === "over");
    assert.equal(over.history.length, 0);
  });

  test("settings: packs, the timer, auto-next", async () => {
    const { host, players } = await setupRoom(server, ["Ann"]);
    await host.ok("updateSettings", { packIds: [] });
    assert.equal((await host.emit("start")).ok, false, "no questions");
    await host.ok("updateSettings", { packIds: ["sample", "no-such-pack"], autoNextSeconds: 3, timerSeconds: 999 });
    const v = await host.waitFor((s) => s.settings.autoNextSeconds === 3);
    assert.deepEqual(v.settings.packIds, ["sample"]);
    assert.equal(v.settings.timerSeconds, 10, "out of range ignored");
    await host.ok("start");
    await question(players[0]);
    await players[0].ok("vote", "b");
    const r = await reveal(host);
    assert.ok(r.nextAt > Date.now());
    const next = await host.waitFor((s) => s.phase === "question" && s.round === 2, "auto next", 6000);
    assert.equal(next.nextAt, undefined);
  });

  test("players leave; the host leaving closes the room", async () => {
    const { host, players } = await setupRoom(server, ["Ann", "Bo"]);
    await players[0].ok("leaveRoom");
    await host.waitFor((s) => s.players.length === 1);
    await host.ok("leaveRoom");
    await new Promise((r) => setTimeout(r, 200));
    assert.match(players[1].closedReason, /host ended/);
  });
});
