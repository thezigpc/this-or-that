// Pack parsing (CSV / JSON), the sample pack, and settings sanitizing: pure functions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { majorityOf, parseCsv, parsePack, sanitizeSettings, SAMPLE_QUESTIONS, MAX_PACK_QUESTIONS } from "@thisorthat/shared";

test("CSV with a header: this/that/prompt/images, quotes and blank lines", () => {
  const p = parsePack('this,that,prompt,this_image,that_image\nBeach,Mountains,,beach.jpg,\n\n"Tea, hot","Kava",Tonight:,,https://x.example/k.png\n', "pack.csv");
  assert.equal(p.questions.length, 2);
  assert.deepEqual(p.questions[0], { a: { label: "Beach", image: "beach.jpg" }, b: { label: "Mountains" } });
  assert.deepEqual(p.questions[1], { prompt: "Tonight:", a: { label: "Tea, hot" }, b: { label: "Kava", image: "https://x.example/k.png" } });
  assert.deepEqual(p.warnings, []);
});

test("CSV without a header, semicolons (European Excel), a BOM, and a bad line", () => {
  const p = parsePack("﻿Cats;Dogs\nOnly one side\nSweet;Salty", "x.csv");
  assert.deepEqual(
    p.questions.map((q) => [q.a.label, q.b.label]),
    [
      ["Cats", "Dogs"],
      ["Sweet", "Salty"],
    ],
  );
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /^Line 2:/);
});

test("a semicolon inside a comma CSV stays in the label", () => {
  assert.deepEqual(parseCsv("a,b\nYes; really,No"), [
    ["a", "b"],
    ["Yes; really", "No"],
  ]);
});

test("JSON: a list, or { name, questions }, with side objects or a/b", () => {
  const list = parsePack('[{"this":"Beach","that":"Mountains","thisImage":"b.jpg"},{"a":{"label":"Tea","image":"t.png"},"b":"Kava","prompt":"Tonight:"},{"this":"x"}]', "p.json");
  assert.equal(list.questions.length, 2);
  assert.deepEqual(list.questions[1], { prompt: "Tonight:", a: { label: "Tea", image: "t.png" }, b: { label: "Kava" } });
  assert.match(list.warnings[0], /^Item 3:/);
  const named = parsePack('{"name":"Kava night","questions":[{"this":"A","that":"B"}]}');
  assert.equal(named.name, "Kava night");
  assert.equal(named.questions.length, 1);
  assert.match(parsePack("{nope", "p.json").warnings[0], /valid JSON/);
});

test("labels are trimmed and capped, packs capped", () => {
  const long = "x".repeat(200);
  const p = parsePack(`this,that\n  ${long}  ,  B  `, "p.csv");
  assert.equal(p.questions[0].a.label.length, 60);
  assert.equal(p.questions[0].b.label, "B");
  const many = parsePack("this,that\n" + Array.from({ length: MAX_PACK_QUESTIONS + 5 }, (_, i) => `a${i},b${i}`).join("\n"), "p.csv");
  assert.equal(many.questions.length, MAX_PACK_QUESTIONS);
  assert.ok(many.warnings.some((w) => /first 500/.test(w)));
});

test("the sample pack is original, unique and well-formed", () => {
  assert.ok(SAMPLE_QUESTIONS.length >= 50);
  const ids = new Set(SAMPLE_QUESTIONS.map((q) => q.id));
  assert.equal(ids.size, SAMPLE_QUESTIONS.length);
  const pairs = new Set(SAMPLE_QUESTIONS.map((q) => `${q.a.label}|${q.b.label}`.toLowerCase()));
  assert.equal(pairs.size, SAMPLE_QUESTIONS.length, "no duplicate pairs");
  assert.ok(SAMPLE_QUESTIONS.some((q) => q.a.label === "Tea" && q.b.label === "Kava"));
  for (const q of SAMPLE_QUESTIONS) assert.ok(q.a.label && q.b.label && q.a.label.length <= 60 && q.b.label.length <= 60);
});

test("settings: bad values dropped, not thrown", () => {
  assert.deepEqual(sanitizeSettings({ timerSeconds: 2, rounds: 10, scoring: "yes", streaks: false, autoNextSeconds: 8, packIds: ["sample", 3, "sample"], junk: 1 }), {
    rounds: 10,
    autoNextSeconds: 8,
    streaks: false,
    packIds: ["sample"],
  });
  assert.deepEqual(sanitizeSettings({ packIds: ["sample", "gone"] }, (id) => id === "sample"), { packIds: ["sample"] });
  assert.deepEqual(sanitizeSettings(null), {});
  assert.deepEqual(sanitizeSettings({ ties: "one" }), { ties: "one" });
  assert.deepEqual(sanitizeSettings({ ties: "everyone" }), {}, "unknown tie rule dropped");
});

test("majority: a, b, tie, nobody", () => {
  assert.equal(majorityOf({ a: 3, b: 1, total: 4 }), "a");
  assert.equal(majorityOf({ a: 1, b: 3, total: 4 }), "b");
  assert.equal(majorityOf({ a: 2, b: 2, total: 4 }), "tie");
  assert.equal(majorityOf({ a: 0, b: 0, total: 0 }), null);
});
