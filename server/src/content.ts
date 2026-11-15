// The questions: the built-in sample pack plus the venue's own packs (CSV/JSON uploaded on
// /admin), and the pictures the venue uploads for them. Everything lives under DATA_DIR:
//   packs/<id>.json   { id, name, createdAt, questions: Question[] }
//   media/<name>      png / jpeg / gif / webp, checked by their first bytes
// A damaged pack file is skipped (and logged), never fatal.

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import { log, newId } from "@bargames/gamekit/server";
import {
  MAX_PACK_NAME,
  SAMPLE_PACK_ID,
  SAMPLE_PACK_NAME,
  SAMPLE_QUESTIONS,
  type DraftQuestion,
  type DraftSide,
  type MediaInfo,
  type PackInfo,
  type ParsedPack,
  type Question,
  type Side,
} from "@thisorthat/shared";
import { DATA_DIR } from "./config.js";

const PACK_DIR = path.join(DATA_DIR, "packs");
const MEDIA_DIR = path.join(DATA_DIR, "media");
export const MAX_PACKS = 100;
export const MAX_MEDIA = 300;
export const MAX_MEDIA_BYTES = 4 * 1024 * 1024;

interface StoredPack {
  id: string;
  name: string;
  createdAt: number;
  questions: Question[];
}

const packs = new Map<string, StoredPack>();

const SAMPLE: StoredPack = { id: SAMPLE_PACK_ID, name: SAMPLE_PACK_NAME, createdAt: 0, questions: SAMPLE_QUESTIONS };

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function initContent(): Promise<void> {
  await mkdir(PACK_DIR, { recursive: true });
  await mkdir(MEDIA_DIR, { recursive: true });
  packs.clear();
  for (const f of await readdir(PACK_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = JSON.parse(await readFile(path.join(PACK_DIR, f), "utf8")) as StoredPack;
      if (typeof p.id !== "string" || typeof p.name !== "string" || !Array.isArray(p.questions)) throw new Error("wrong shape");
      packs.set(p.id, p);
    } catch (err) {
      log.warn("content", "skipped a damaged pack file", { file: f, err: String(err) });
    }
  }
  log.info("content", "loaded packs", { packs: packs.size });
}

const info = (p: StoredPack): PackInfo => ({ id: p.id, name: p.name, count: p.questions.length, builtIn: p.id === SAMPLE_PACK_ID });

/** The sample pack first, then the venue's packs, newest first. */
export function listPacks(): PackInfo[] {
  return [info(SAMPLE), ...[...packs.values()].sort((a, b) => b.createdAt - a.createdAt).map(info)];
}

export const hasPack = (id: string): boolean => id === SAMPLE_PACK_ID || packs.has(id);

export function packQuestions(id: string): Question[] {
  return id === SAMPLE_PACK_ID ? SAMPLE.questions : (packs.get(id)?.questions ?? []);
}

// ------------------------------------------------------------------ media

const SAFE_URL = /^https:\/\/[^\s"'<>]+$/i;

/** png / jpeg / gif / webp from the first bytes; anything else (SVG included) is refused. */
export function imageType(buf: Buffer): { ext: string; mime: string } | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", mime: "image/png" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return { ext: "gif", mime: "image/gif" };
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return { ext: "webp", mime: "image/webp" };
  return undefined;
}

export const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** A safe file name: lowercase letters, digits, dots, dashes; the detected extension. */
function mediaName(original: string, ext: string): string {
  const base =
    path
      .basename(original)
      .replace(/\.[^.]*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "picture";
  return `${base}.${ext}`;
}

const isMediaName = (n: string) => /^[a-z0-9-]+(-\d+)?\.(png|jpg|gif|webp)$/.test(n);

export async function listMedia(): Promise<MediaInfo[]> {
  const out: MediaInfo[] = [];
  for (const name of (await readdir(MEDIA_DIR)).sort()) {
    if (!isMediaName(name)) continue;
    const s = await stat(path.join(MEDIA_DIR, name)).catch(() => null);
    if (s?.isFile()) out.push({ name, path: `media/${name}`, bytes: s.size });
  }
  return out;
}

/** Saves an uploaded picture; the name is the upload's, made safe and unique. */
export async function saveMedia(original: string, data: Buffer): Promise<MediaInfo> {
  const type = imageType(data);
  if (!type) throw new Error("Only PNG, JPEG, GIF and WebP pictures can be uploaded.");
  if (data.length > MAX_MEDIA_BYTES) throw new Error("Pictures can be at most 4 MB.");
  const existing = await readdir(MEDIA_DIR);
  if (existing.length >= MAX_MEDIA) throw new Error(`There are already ${MAX_MEDIA} pictures. Delete some first.`);
  let name = mediaName(original, type.ext);
  for (let n = 2; existing.includes(name); n++) name = mediaName(original, type.ext).replace(/\.(\w+)$/, `-${n}.$1`);
  await writeAtomic(path.join(MEDIA_DIR, name), data);
  log.info("content", "picture uploaded", { name, bytes: data.length });
  return { name, path: `media/${name}`, bytes: data.length };
}

export async function deleteMedia(name: string): Promise<boolean> {
  if (!isMediaName(name)) return false;
  try {
    await unlink(path.join(MEDIA_DIR, name));
    return true;
  } catch {
    return false;
  }
}

/** The file to serve for /media/<name>, if it exists. */
export function mediaFile(name: string): string | undefined {
  return isMediaName(name) ? path.join(MEDIA_DIR, name) : undefined;
}

// ------------------------------------------------------------------ packs

/**
 * An image reference from a pack file → what goes in the question: an https URL as-is, or
 * the name of a picture uploaded on /admin ("beach.jpg" or "media/beach.jpg").
 */
function resolveImage(ref: string | undefined, media: Set<string>, where: string, warnings: string[]): string | undefined {
  if (!ref) return undefined;
  if (SAFE_URL.test(ref)) return ref;
  const name = ref.replace(/^\/?media\//, "").toLowerCase();
  if (media.has(name)) return `media/${name}`;
  warnings.push(`${where}: no uploaded picture called "${ref}" (upload it first, or use an https:// address).`);
  return undefined;
}

export async function savePack(rawName: string, parsed: ParsedPack): Promise<{ pack: PackInfo; warnings: string[] }> {
  const warnings = [...parsed.warnings];
  if (!parsed.questions.length) throw new Error(warnings[0] ?? "No questions found in that file.");
  if (packs.size >= MAX_PACKS) throw new Error(`There are already ${MAX_PACKS} packs. Delete some first.`);
  const name = (rawName.trim() || parsed.name || "My pack").replace(/\s+/g, " ").slice(0, MAX_PACK_NAME);
  const media = new Set((await listMedia()).map((m) => m.name));
  const id = `p${newId()}`;
  const side = (s: DraftSide, where: string): Side => {
    const image = resolveImage(s.image, media, where, warnings);
    return image ? { label: s.label, image } : { label: s.label };
  };
  const questions: Question[] = parsed.questions.map((q: DraftQuestion, i) => ({
    id: `${id}-${i + 1}`,
    ...(q.prompt ? { prompt: q.prompt } : {}),
    a: side(q.a, `Question ${i + 1}`),
    b: side(q.b, `Question ${i + 1}`),
  }));
  const pack: StoredPack = { id, name, createdAt: Date.now(), questions };
  await writeAtomic(path.join(PACK_DIR, `${id}.json`), JSON.stringify(pack, null, 1));
  packs.set(id, pack);
  log.info("content", "pack saved", { id, name, questions: questions.length, warnings: warnings.length });
  return { pack: info(pack), warnings };
}

export async function deletePack(id: string): Promise<boolean> {
  if (id === SAMPLE_PACK_ID || !packs.has(id)) return false;
  packs.delete(id);
  await unlink(path.join(PACK_DIR, `${id}.json`)).catch(() => undefined);
  log.info("content", "pack deleted", { id });
  return true;
}
