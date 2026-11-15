// Question packs the venue uploads, as CSV or JSON. Pure parsing: the server checks the
// image references (an https URL, or the name of a picture uploaded on the admin page).

export const MAX_PACK_QUESTIONS = 500;
export const MAX_LABEL = 60;
export const MAX_PROMPT = 80;
export const MAX_PACK_NAME = 40;

export interface DraftSide {
  label: string;
  /** As written in the file: an https URL or an uploaded picture's name. */
  image?: string;
}
export interface DraftQuestion {
  prompt?: string;
  a: DraftSide;
  b: DraftSide;
}
export interface ParsedPack {
  name?: string;
  questions: DraftQuestion[];
  /** Lines or items that were skipped, and why. */
  warnings: string[];
}

const clean = (v: unknown, max: number): string =>
  typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim().slice(0, max) : "";

/** The separator, from the first line: tab, else comma, else semicolon (European Excel). */
function delimiterOf(s: string): string {
  const first = s.split(/\r?\n/, 1)[0] ?? "";
  if (first.includes("\t")) return "\t";
  if (first.includes(",")) return ",";
  return first.includes(";") ? ";" : ",";
}

/** RFC 4180-style CSV: quoted fields, "" escapes, separators/newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  const sep = delimiterOf(s);
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

// Header names we understand (lowercased, spaces and dashes as underscores).
const COLS: Record<string, keyof Cols> = {
  this: "a",
  a: "a",
  option_a: "a",
  left: "a",
  that: "b",
  b: "b",
  option_b: "b",
  right: "b",
  prompt: "prompt",
  question: "prompt",
  this_image: "aImage",
  a_image: "aImage",
  image_a: "aImage",
  left_image: "aImage",
  that_image: "bImage",
  b_image: "bImage",
  image_b: "bImage",
  right_image: "bImage",
};
interface Cols {
  a: number;
  b: number;
  prompt: number;
  aImage: number;
  bImage: number;
}

function draft(prompt: unknown, a: unknown, b: unknown, aImage: unknown, bImage: unknown): DraftQuestion | string {
  const al = clean(a, MAX_LABEL);
  const bl = clean(b, MAX_LABEL);
  if (!al || !bl) return "both sides need a name";
  const q: DraftQuestion = { a: { label: al }, b: { label: bl } };
  const p = clean(prompt, MAX_PROMPT);
  if (p) q.prompt = p;
  const ai = clean(aImage, 500);
  const bi = clean(bImage, 500);
  if (ai) q.a.image = ai;
  if (bi) q.b.image = bi;
  return q;
}

/**
 * CSV with a header row (this, that, prompt, this_image, that_image; or a, b, …) or none
 * (then: this, that, this_image, that_image). Semicolons and tabs work as separators too.
 */
export function parseCsvPack(text: string): ParsedPack {
  const rows = parseCsv(text);
  const warnings: string[] = [];
  const questions: DraftQuestion[] = [];
  if (!rows.length) return { questions, warnings: ["The file is empty."] };
  const head = rows[0]!.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const cols: Partial<Cols> = {};
  head.forEach((h, i) => {
    const k = COLS[h];
    if (k && cols[k] === undefined) cols[k] = i;
  });
  const hasHeader = cols.a !== undefined && cols.b !== undefined;
  const c: Cols = hasHeader
    ? { a: cols.a!, b: cols.b!, prompt: cols.prompt ?? -1, aImage: cols.aImage ?? -1, bImage: cols.bImage ?? -1 }
    : { a: 0, b: 1, prompt: -1, aImage: 2, bImage: 3 };
  rows.slice(hasHeader ? 1 : 0).forEach((r, i) => {
    const line = i + (hasHeader ? 2 : 1);
    const at = (n: number) => (n >= 0 ? r[n] : undefined);
    const q = draft(at(c.prompt), at(c.a), at(c.b), at(c.aImage), at(c.bImage));
    if (typeof q === "string") warnings.push(`Line ${line}: ${q}.`);
    else questions.push(q);
  });
  return cap({ questions, warnings });
}

/**
 * JSON: an array of questions, or { name, questions: [...] }. A question is
 * { "this": "Beach", "that": "Mountains" } (or a/b), with optional "prompt",
 * "thisImage"/"thatImage" (or aImage/bImage), or sides as { label, image } objects.
 */
export function parseJsonPack(text: string): ParsedPack {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { questions: [], warnings: ["That isn't valid JSON."] };
  }
  const obj = (data ?? {}) as { name?: unknown; questions?: unknown };
  const list = Array.isArray(data) ? data : Array.isArray(obj.questions) ? obj.questions : null;
  if (!list) return { questions: [], warnings: ['Expected a list of questions, or { "questions": [...] }.'] };
  const warnings: string[] = [];
  const questions: DraftQuestion[] = [];
  list.forEach((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const side = (v: unknown) => (v && typeof v === "object" ? (v as { label?: unknown; image?: unknown }) : { label: v });
    const sa = side(o.this ?? o.a);
    const sb = side(o.that ?? o.b);
    const q = draft(o.prompt, sa.label, sb.label, o.thisImage ?? o.aImage ?? (sa as { image?: unknown }).image, o.thatImage ?? o.bImage ?? (sb as { image?: unknown }).image);
    if (typeof q === "string") warnings.push(`Item ${i + 1}: ${q}.`);
    else questions.push(q);
  });
  const name = clean(Array.isArray(data) ? undefined : obj.name, MAX_PACK_NAME) || undefined;
  return cap({ name, questions, warnings });
}

function cap(p: ParsedPack): ParsedPack {
  if (p.questions.length > MAX_PACK_QUESTIONS) {
    p.warnings.push(`Only the first ${MAX_PACK_QUESTIONS} questions were kept.`);
    p.questions = p.questions.slice(0, MAX_PACK_QUESTIONS);
  }
  return p;
}

/** Picks the parser from the file name (or content when there's no extension). */
export function parsePack(text: string, fileName = ""): ParsedPack {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".json")) return parseJsonPack(text);
  if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt")) return parseCsvPack(text);
  const t = text.trimStart();
  return t.startsWith("[") || t.startsWith("{") ? parseJsonPack(text) : parseCsvPack(text);
}
