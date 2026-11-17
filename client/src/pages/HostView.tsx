import { useRef, useState, type FormEvent } from "react";
import { JoinAddress } from "@bargames/gamekit/client";
import { joinDisplay, joinUrl } from "@bargames/sdk/client";
import { AUTO_NEXT_CHOICES, ROUND_CHOICES, TIMER_CHOICES, type Choice, type RoomSettings, type RoomView } from "@thisorthat/shared";
import { Outcome, QrCode, resizeImage, Scoreboard, secondsLeft, SplitBar, useTick } from "../components/bits";
import { call, slowCall } from "../socket";
import { setSettingsDefault } from "../session";
import { useVenue } from "../useVenue";
import { RevealCard, VoteButtons } from "./PlayerView";
import type { Act } from "./RoomPage";

export function HostView({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const isHost = view.you.role === "host";
  return (
    <main className="host">
      <GamePanel view={view} skew={skew} act={act} />
      <AskPanel view={view} />
      <SettingsPanel view={view} act={act} />
      <JoinPanel view={view} />
      <PeoplePanel view={view} act={act} isHost={isHost} />
      {isHost && (
        <section className="panel">
          <button
            className="btn btn-danger"
            onClick={() => {
              if (window.confirm("Close this room for everyone?")) void act("closeRoom");
            }}
          >
            Close room
          </button>
        </section>
      )}
    </main>
  );
}

function GamePanel({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const now = useTick(!!view.nextAt, 500);
  const s = view.settings;
  const of = s.rounds > 0 ? ` of ${s.rounds}` : "";
  return (
    <section className="panel game-panel">
      {view.phase === "lobby" && (
        <>
          <h2>Ready when you are</h2>
          <p className="muted">
            {view.players.length === 1 ? "1 player" : `${view.players.length} players`} in. {view.remaining + view.queued} questions ready.
          </p>
          <button className="btn btn-primary btn-big" onClick={() => act("start")}>
            Start
          </button>
        </>
      )}
      {view.phase === "question" && view.question && (
        <>
          <p className="muted small">
            Question {view.round}
            {of} · {view.votes} of {view.voters} voted
          </p>
          <VoteButtons view={view} skew={skew} act={act} />
          {view.tally ? <SplitBar tally={view.tally} revealed={false} live /> : <p className="muted small center">Scoring is on: the split stays hidden until the reveal.</p>}
          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => act("reveal")}>
              Reveal now
            </button>
            <button className="btn btn-ghost" onClick={() => act("skip")}>
              Skip
            </button>
            <button className="btn btn-ghost" onClick={() => act("endGame")}>
              End game
            </button>
          </div>
        </>
      )}
      {view.phase === "reveal" && view.result && (
        <>
          <p className="muted small">
            Question {view.round}
            {of}
          </p>
          <RevealCard view={view} showYou={!!view.you.choice} />
          {view.nextAt && <p className="muted small center">Next question in {secondsLeft(view.nextAt, skew, now)}…</p>}
          <div className="btn-row">
            <button className="btn btn-primary btn-big" onClick={() => act("next")}>
              {s.rounds > 0 && view.round >= s.rounds ? "Finish" : "Next question"}
            </button>
            <button className="btn btn-ghost" onClick={() => act("endGame")}>
              End game
            </button>
          </div>
        </>
      )}
      {view.phase === "over" && (
        <>
          <h2>Game over</h2>
          <p className="muted">{view.history.length} questions.</p>
          <Outcome view={view} />
          {s.scoring && <Scoreboard players={view.players} scoring streaks={s.streaks} limit={10} />}
          <button className="btn btn-primary btn-big" onClick={() => act("start")}>
            Play again
          </button>
        </>
      )}
      {(view.phase === "question" || view.phase === "reveal") && (
        <p className="muted small">
          {view.queued > 0 ? `${view.queued} of your questions up next, then ` : ""}
          {view.remaining} left in the packs.
        </p>
      )}
    </section>
  );
}

/** The host's own question. `onClose`: shown as a box over the big screen (with a close button). */
export function AskPanel({ view, onAsked, onClose, className = "" }: { view: RoomView; onAsked?: () => void; onClose?: () => void; className?: string }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [prompt, setPrompt] = useState("");
  const [img, setImg] = useState<{ a?: string; b?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const pickImage = async (c: Choice, file: File | undefined) => {
    setError("");
    if (!file) return setImg((x) => ({ ...x, [c]: undefined }));
    try {
      const data = await resizeImage(file);
      setImg((x) => ({ ...x, [c]: data }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const aRef = useRef<HTMLInputElement>(null);
  const bRef = useRef<HTMLInputElement>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Enter on a field moves on to the next empty side first (on-screen keyboards too).
    if (!a.trim()) return aRef.current?.focus();
    if (!b.trim()) return bRef.current?.focus();
    setBusy(true);
    setError("");
    setNote("");
    try {
      const r = await slowCall<{ now: boolean }>("ask", { a, b, prompt: prompt || undefined, aImage: img.a, bImage: img.b });
      setNote(r.now ? "Asked!" : "It's up next.");
      setA("");
      setB("");
      setPrompt("");
      setImg({});
      onAsked?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const asksNow = view.phase === "lobby" || view.phase === "reveal";
  const side = (c: Choice, value: string, set: (v: string) => void) => (
    <div className={`ask-side ask-${c}`}>
      <input ref={c === "a" ? aRef : bRef} maxLength={60} value={value} onChange={(e) => set(e.target.value.slice(0, 60))} placeholder={c === "a" ? "This (e.g. Beach)" : "That (e.g. Mountains)"} aria-label={c === "a" ? "This" : "That"} />
      <label className="ask-photo">
        {img[c] ? <img src={img[c]} alt="" /> : <span>📷 Picture</span>}
        <input type="file" accept="image/*" onChange={(e) => void pickImage(c, e.target.files?.[0])} />
      </label>
      {img[c] && (
        <button type="button" className="link-btn small" onClick={() => setImg((x) => ({ ...x, [c]: undefined }))}>
          Remove picture
        </button>
      )}
    </div>
  );
  return (
    <form className={`panel ask ${className}`} onSubmit={submit}>
      <div className="ask-head">
        <h3>Ask your own</h3>
        {onClose && (
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
            ✕
          </button>
        )}
      </div>
      <input maxLength={80} value={prompt} onChange={(e) => setPrompt(e.target.value.slice(0, 80))} placeholder="Lead-in (optional), e.g. Friday night:" aria-label="Lead-in" />
      <div className="ask-sides">
        {side("a", a, setA)}
        <span className="ask-or">or</span>
        {side("b", b, setB)}
      </div>
      {error && <p className="error">{error}</p>}
      {note && <p className="note">{note}</p>}
      <button className="btn btn-secondary" disabled={busy}>
        {busy ? "Sending…" : asksNow ? "Ask it now" : "Ask it next"}
      </button>
    </form>
  );
}

function SettingsPanel({ view, act }: { view: RoomView; act: Act }) {
  const s = view.settings;
  const set = async (patch: Partial<RoomSettings>) => {
    const r = await act("updateSettings", patch);
    if (r) setSettingsDefault({ ...s, ...patch }); // this device's defaults for its next room
  };
  const togglePack = (id: string, on: boolean) => {
    const ids = on ? [...s.packIds, id] : s.packIds.filter((x) => x !== id);
    void set({ packIds: ids });
  };
  return (
    <section className="panel settings">
      <h3>Settings</h3>
      <label className="row">
        <span>Time to vote</span>
        <select value={s.timerSeconds} onChange={(e) => void set({ timerSeconds: Number(e.target.value) })}>
          {[...new Set([...TIMER_CHOICES, s.timerSeconds])].sort((x, y) => x - y).map((t) => (
            <option key={t} value={t}>
              {t} seconds
            </option>
          ))}
        </select>
      </label>
      <label className="row">
        <span>Questions per game</span>
        <select value={s.rounds} onChange={(e) => void set({ rounds: Number(e.target.value) })}>
          {[...new Set([...ROUND_CHOICES, s.rounds])].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "Until they run out" : n}
            </option>
          ))}
        </select>
      </label>
      <label className="row">
        <span>After a reveal</span>
        <select value={s.autoNextSeconds} onChange={(e) => void set({ autoNextSeconds: Number(e.target.value) })}>
          {[...new Set([...AUTO_NEXT_CHOICES, s.autoNextSeconds])].sort((x, y) => x - y).map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "Wait for Next" : `Next by itself after ${n} s`}
            </option>
          ))}
        </select>
      </label>
      <label className="row check">
        <input type="checkbox" checked={s.scoring} onChange={(e) => void set({ scoring: e.target.checked })} />
        <span>
          Scoring: guess the majority
          <small className="muted">A point for picking what most people pick. The split stays hidden until the reveal.</small>
        </span>
      </label>
      <label className="row check">
        <input type="checkbox" checked={s.streaks} onChange={(e) => void set({ streaks: e.target.checked })} />
        <span>
          Streaks
          <small className="muted">🔥 for picking with the majority several times in a row.</small>
        </span>
      </label>
      {s.scoring && (
        <label className="row">
          <span>
            A tie for first
            <small className="muted">{s.ties === "one" ? "Tiebreaks: the longest streak, then the fastest votes." : "Everyone tied on the top score wins."}</small>
          </span>
          <select value={s.ties} onChange={(e) => void set({ ties: e.target.value as RoomSettings["ties"] })}>
            <option value="share">Everyone tied wins</option>
            <option value="one">One winner</option>
          </select>
        </label>
      )}
      <fieldset className="packs">
        <legend>Question packs</legend>
        {view.packs.map((p) => (
          <label key={p.id} className="row check">
            <input type="checkbox" checked={s.packIds.includes(p.id)} onChange={(e) => togglePack(p.id, e.target.checked)} />
            <span>
              {p.name} <small className="muted">({p.count})</small>
            </span>
          </label>
        ))}
        {!s.packIds.length && <p className="muted small">No packs picked: only your own questions will be asked.</p>}
      </fieldset>
    </section>
  );
}

function JoinPanel({ view }: { view: RoomView }) {
  const venue = useVenue();
  const join = joinDisplay(venue, `/join/${view.code}`, view.code);
  const tvLink = joinUrl(venue, `/room/${view.code}?role=table`);
  return (
    <section className="panel join-panel">
      <h3>Join and TV</h3>
      <div className="join-box">
        <QrCode text={join.url} size={150} />
        <div>
          <JoinAddress url={join.roomShort ?? join.short} align="start" />
          <p className="room-code-big">{view.code}</p>
        </div>
      </div>
      <a className="btn btn-ghost" href={tvLink} target="_blank" rel="noreferrer">
        Open the TV view in a new tab
      </a>
    </section>
  );
}

function PeoplePanel({ view, act, isHost }: { view: RoomView; act: Act; isHost: boolean }) {
  const [invite, setInvite] = useState<{ url: string; expiresAt: string } | null>(null);
  const venue = useVenue();
  const makeInvite = async () => {
    try {
      const r = await call<{ path: string; expiresAt: string }>("cohostInvite");
      setInvite({ url: joinUrl(venue, r.path), expiresAt: r.expiresAt });
    } catch {
      /* the toast path isn't needed: the button just does nothing */
    }
  };
  return (
    <section className="panel people">
      <h3>Players ({view.players.length})</h3>
      {view.settings.scoring ? (
        <Scoreboard players={view.players} scoring streaks={view.settings.streaks} />
      ) : (
        <ul className="names">
          {view.players.map((p) => (
            <li key={p.id} className={p.connected ? "" : "away"}>
              {p.name}
            </li>
          ))}
        </ul>
      )}
      {isHost && view.players.length > 0 && (
        <details>
          <summary className="muted small">Remove a player</summary>
          <ul className="names">
            {view.players
              .filter((p) => p.id !== view.you.id)
              .map((p) => (
                <li key={p.id}>
                  {p.name}{" "}
                  <button
                    className="link-btn small"
                    onClick={() => {
                      if (window.confirm(`Remove ${p.name}?`)) void act("kick", p.id);
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
          </ul>
        </details>
      )}
      {isHost && (
        <div className="cohosts">
          <h4>Co-hosts</h4>
          {view.cohosts?.length ? (
            <ul className="names">
              {view.cohosts.map((c) => (
                <li key={c.id}>
                  {c.name}{" "}
                  <button className="link-btn small" onClick={() => void act("removeCohost", c.id)}>
                    Make a player
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">A co-host can run the game with you, but can't close the room or remove anyone.</p>
          )}
          {invite ? (
            <div className="join-box">
              <QrCode text={invite.url} size={150} />
              <p className="muted small">
                Scan to join as a co-host. Works once, until {new Date(invite.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
              </p>
            </div>
          ) : null}
          <button className="btn btn-ghost" onClick={() => void makeInvite()}>
            {invite ? "New co-host link" : "Add a co-host"}
          </button>
        </div>
      )}
    </section>
  );
}
