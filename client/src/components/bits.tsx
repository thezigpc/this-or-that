import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { percent, type Choice, type RoundResult, type ScoreLine, type Side, type Tally } from "@thisorthat/shared";
import { mediaUrl } from "../socket";

export function QrCode({ text, size = 160, className = "qr" }: { text: string; size?: number; className?: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: Math.max(256, size * 2) })
      .then(setSrc)
      .catch(() => setSrc(""));
  }, [text, size]);
  return src ? <img className={className} src={src} width={size} height={size} alt={`QR code for ${text}`} /> : null;
}

/** Re-renders every `ms` while `active`. */
export function useTick(active: boolean, ms = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

/** Seconds left until a server time, corrected for clock skew. */
export function secondsLeft(at: number | undefined, skew: number, now: number): number {
  return at ? Math.max(0, Math.ceil((at - (now + skew)) / 1000)) : 0;
}

/** A ring that empties as voting time runs out, with the seconds inside. */
export function Countdown({ endsAt, skew, total, className = "" }: { endsAt?: number; skew: number; total: number; className?: string }) {
  const now = useTick(!!endsAt, 200);
  if (!endsAt) return null;
  const msLeft = Math.max(0, endsAt - (now + skew));
  const secs = Math.ceil(msLeft / 1000);
  const frac = Math.min(1, msLeft / (total * 1000));
  const r = 44;
  const c = 2 * Math.PI * r;
  return (
    <div className={`countdown ${secs <= 3 ? "countdown-low" : ""} ${className}`} role="timer" aria-label={`${secs} seconds left`}>
      <svg viewBox="0 0 100 100" aria-hidden>
        <circle cx="50" cy="50" r={r} className="countdown-track" />
        <circle cx="50" cy="50" r={r} className="countdown-fill" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} />
      </svg>
      <span>{secs}</span>
    </div>
  );
}

export function SideImage({ side, className = "side-img" }: { side: Side; className?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [side.image]);
  if (!side.image || broken) return null;
  return <img className={className} src={mediaUrl(side.image)} alt="" onError={() => setBroken(true)} draggable={false} />;
}

export const sideName = (c: Choice) => (c === "a" ? "This" : "That");

/**
 * The room's split: side A from the left, side B from the right. Before `revealed` it sits
 * at 50/50 (or follows the live tally when given), then slides to the result.
 */
export function SplitBar({ tally, revealed, live, labels }: { tally?: Tally; revealed: boolean; live?: boolean; labels?: [string, string] }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!revealed) return setShown(false);
    const t = setTimeout(() => setShown(true), 60); // start from 50/50, then slide
    return () => clearTimeout(t);
  }, [revealed]);
  const t = tally ?? { a: 0, b: 0, total: 0 };
  const show = (revealed && shown) || (live && t.total > 0);
  const pa = t.total ? (t.a / t.total) * 100 : 50;
  const a = show ? pa : 50;
  const pctA = percent(t.a, t.total);
  const pctB = t.total ? 100 - pctA : 0;
  return (
    <div className={`split ${revealed ? "split-revealed" : ""}`} aria-label={show ? `${pctA}% ${labels?.[0] ?? "this"}, ${pctB}% ${labels?.[1] ?? "that"}` : "Split hidden"}>
      {/* A sliver can't hold its number: the other side's number says it all. */}
      <div className="split-a" style={{ width: `${a}%` }}>
        {show && a >= 14 && <span className="split-pct">{pctA}%</span>}
      </div>
      <div className="split-b" style={{ width: `${100 - a}%` }}>
        {show && 100 - a >= 14 && <span className="split-pct">{pctB}%</span>}
      </div>
    </div>
  );
}

/** A playful line for the reveal. */
export function quip(r: RoundResult): string {
  const { a, b, total } = r.tally;
  if (total === 0) return "Nobody voted! 🦗";
  const win = r.majority === "a" ? r.question.a.label : r.majority === "b" ? r.question.b.label : "";
  if (r.majority === "tie") return "Dead even! The room is split right down the middle.";
  const top = Math.max(a, b);
  const pct = percent(top, total);
  if (top === total) return total === 1 ? `Unanimous… well, one vote: ${win}!` : `Unanimous! Everyone picked ${win}.`;
  if (pct >= 80) return `Landslide! ${win} wins big.`;
  if (pct >= 60) return `${win} takes it.`;
  return `Close call! ${win} by a nose.`;
}

export function Scoreboard({ players, scoring, streaks, limit, highlight }: { players: ScoreLine[]; scoring: boolean; streaks: boolean; limit?: number; highlight?: string }) {
  const list = limit ? players.slice(0, limit) : players;
  if (!list.length) return null;
  return (
    <ol className="scores">
      {list.map((p) => (
        <li key={p.id} className={`${p.id === highlight ? "me" : ""} ${p.connected ? "" : "away"}`}>
          {scoring && <span className="scores-place">{1 + players.filter((o) => o.score > p.score).length}</span>}
          <span className="scores-name">{p.name}</span>
          {streaks && p.streak >= 2 && <span className="streak">🔥{p.streak}</span>}
          {scoring && <span className="scores-pts">{p.score}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Shrinks a phone photo to a JPEG data URL small enough to send (the server takes 600 KB). */
export async function resizeImage(file: File, maxSide = 900): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That picture couldn't be opened."));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const g = canvas.getContext("2d");
    if (!g) throw new Error("That picture couldn't be opened.");
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of [0.82, 0.7, 0.55, 0.4]) {
      const data = canvas.toDataURL("image/jpeg", q);
      if (data.length * 0.75 < 560 * 1024) return data;
    }
    throw new Error("That picture is too big. Try a smaller one.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
