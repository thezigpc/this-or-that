// /admin: the password, rooms, defaults, the venue's packs (CSV/JSON) and pictures.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, setupRoom } from "../harness.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const dataDir = mkdtempSync(path.join(os.tmpdir(), "thisorthat-admin-"));
let server;
let token;

const api = async (p, { method = "GET", body, raw, auth = token } = {}) => {
  const res = await fetch(`${server.url}/api/admin${p}`, {
    method: raw !== undefined || body !== undefined ? (method === "GET" ? "POST" : method) : method,
    headers: { ...(raw === undefined ? { "content-type": "application/json" } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

before(async () => {
  server = await startServer({ DATA_DIR: dataDir });
});
after(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

test("first-run setup, then sign in", async () => {
  assert.equal((await api("/status", { auth: "" })).body.setupNeeded, true);
  const setup = await api("/setup", { method: "POST", body: { password: "correct horse" }, auth: "" });
  assert.equal(setup.status, 200);
  token = setup.body.token;
  assert.equal((await api("/overview")).status, 200);
  assert.equal((await api("/overview", { auth: "wrong" })).status, 401);
  assert.equal((await api("/upload/pack", { raw: "a,b", auth: "wrong" })).status, 401, "uploads need a session too");
});

test("pictures: real images only, safe unique names", async () => {
  const up = await api("/upload/media?file=My%20Beach!.PNG", { raw: PNG });
  assert.equal(up.status, 200);
  assert.equal(up.body.media.name, "my-beach.png");
  const again = await api("/upload/media?file=my-beach.png", { raw: PNG });
  assert.equal(again.body.media.name, "my-beach-2.png");
  const svg = await api("/upload/media?file=x.svg", { raw: Buffer.from("<svg onload=alert(1)></svg>") });
  assert.equal(svg.status, 400);
  const served = await fetch(`${server.url}/media/my-beach.png`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal((await fetch(`${server.url}/media/..%2Fadmin.json`)).status, 404);
  assert.equal((await api("/media/my-beach-2.png", { method: "DELETE" })).status, 200);
  assert.deepEqual((await api("/overview")).body.media.map((m) => m.name), ["my-beach.png"]);
});

test("a CSV pack: uploaded pictures and https images resolve, unknown ones are noted", async () => {
  const csv = "this,that,this_image,that_image\nBeach,Mountains,my-beach.png,https://img.example/m.jpg\nTea,Kava,missing.png,\nonly one,\n";
  const up = await api("/upload/pack?name=Kava%20night&file=kava.csv", { raw: csv });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.pack.name, "Kava night");
  assert.equal(up.body.pack.count, 2);
  assert.equal(up.body.warnings.length, 2);
  assert.ok(up.body.warnings.some((w) => /missing\.png/.test(w)));
  const bad = await api("/upload/pack?file=x.json", { raw: "[]" });
  assert.equal(bad.status, 400);

  // Make it the default for new rooms: a room plays only those two.
  const packs = (await api("/overview")).body.packs;
  const kava = packs.find((p) => p.name === "Kava night");
  assert.equal(packs[0].id, "sample", "the sample pack is listed first");
  assert.equal((await api("/settings", { method: "PUT", body: { roomDefaults: { packIds: [kava.id], rounds: 0 } } })).status, 200);
  const { host, players } = await setupRoom(server, ["Ann"]);
  await host.ok("start");
  const labels = new Set();
  for (let i = 0; i < 2; i++) {
    const q = await host.waitFor((s) => s.phase === "question" && s.round === i + 1);
    labels.add(q.question.a.label);
    if (q.question.a.label === "Beach") {
      assert.equal(q.question.a.image, "media/my-beach.png");
      assert.equal(q.question.b.image, "https://img.example/m.jpg");
    } else assert.equal(q.question.a.image, undefined);
    await players[0].ok("vote", "a");
    await host.waitFor((s) => s.phase === "reveal");
    await host.ok("next");
  }
  assert.deepEqual([...labels].sort(), ["Beach", "Tea"]);
  assert.equal((await host.waitFor((s) => s.phase === "over")).history.length, 2, "until the packs run out");
});

test("a JSON pack, deleting packs, and they survive a restart", async () => {
  const up = await api("/upload/pack?file=p.json", { raw: JSON.stringify({ name: "Office", questions: [{ this: "Stand", that: "Sit" }] }) });
  assert.equal(up.body.pack.name, "Office");
  assert.equal((await api("/packs/sample", { method: "DELETE" })).status, 404, "the sample can't be deleted");
  await server.stop();
  server = await startServer({ DATA_DIR: dataDir });
  token = (await api("/login", { method: "POST", body: { password: "correct horse" }, auth: "" })).body.token;
  const names = (await api("/overview")).body.packs.map((p) => p.name);
  assert.deepEqual(names.sort(), ["Kava night", "Office", "Sample pack"]);
  const office = (await api("/overview")).body.packs.find((p) => p.name === "Office");
  assert.equal((await api(`/packs/${office.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await api("/overview")).body.packs.length, 2);
});

test("rooms: listed and closed by the admin", async () => {
  const { code, players } = await setupRoom(server, ["Zed"]);
  const rooms = (await api("/overview")).body.rooms;
  assert.ok(rooms.some((r) => r.code === code && r.players === 1));
  assert.equal((await api(`/rooms/${code}/close`, { method: "POST" })).status, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.match(players[0].closedReason, /administrator/);
});
