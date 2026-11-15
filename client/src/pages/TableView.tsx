import { isOnBox, joinDisplay } from "@bargames/sdk/client";
import { JoinAddress } from "@bargames/gamekit/client";
import { percent, type Choice, type RoomView, type RoundResult } from "@thisorthat/shared";
import { Countdown, QrCode, quip, Scoreboard, secondsLeft, SideImage, SplitBar, useTick } from "../components/bits";
import { toggleFullscreen } from "../fullscreen";
import { useGameName } from "../useGameName";
import { useVenue } from "../useVenue";
import type { Act } from "./RoomPage";

/**
 * The big screen: the question, both sides, the live split, the reveal, and the join QR and
 * short link. Built for 1920x1080 seen across a room; nothing on it needs a pointer (a box
 * TV has none). `onHostControls`: the host's own device showing this view, with controls.
 */
export function TableView({ view, skew, act, onHostControls, boxTv }: { view: RoomView; skew: number; act: Act; onHostControls?: () => void; boxTv?: boolean }) {
  const venue = useVenue();
  const gameName = useGameName();
  const join = joinDisplay(venue, `/join/${view.code}`, view.code);
  const address = join.roomShort ?? join.short;
  const logo = isOnBox(venue) ? venue.game.theme.logoUrl : undefined;
  const s = view.settings;
  const lobby = view.phase === "lobby";
  const of = s.rounds > 0 ? ` of ${s.rounds}` : "";

  return (
    <div className={`tv tv-phase-${view.phase} ${lobby ? "" : "tv-has-corner"}`}>
      <header className="tv-top">
        <div className="tv-title">
          {logo && <img className="tv-logo" src={logo} alt="" />}
          <span>{gameName}</span>
        </div>
        <div className="tv-round">
          {view.phase === "question" || view.phase === "reveal" ? `Question ${view.round}${of}` : view.phase === "over" ? "Final results" : "Get your phones out!"}
        </div>
        {!boxTv && (
          <button className="icon-btn tv-fs" onClick={toggleFullscreen} title="Full screen" aria-label="Full screen">
            ⛶
          </button>
        )}
      </header>

      <main className="tv-main">
        {lobby && <TvLobby view={view} url={join.url} address={address} />}
        {(view.phase === "question" || view.phase === "reveal") && view.question && <TvQuestion view={view} skew={skew} />}
        {view.phase === "over" && <TvOver view={view} />}
      </main>

      {!lobby && (
        <aside className="tv-corner">
          <QrCode text={join.url} size={150} className="qr tv-corner-qr" />
          <div className="tv-corner-text">
            <JoinAddress url={address} minScale={0.8} lines={2} className="tv-join-address" />
            <span className="tv-code">{view.code}</span>
          </div>
        </aside>
      )}

      {onHostControls && <TvControls view={view} act={act} onHostControls={onHostControls} />}
    </div>
  );
}

function TvLobby({ view, url, address }: { view: RoomView; url: string; address: string }) {
  return (
    <div className="tv-lobby">
      <div className="tv-join">
        <QrCode text={url} size={420} className="qr tv-join-qr" />
        <JoinAddress url={address} minScale={0.8} lines={2} className="tv-join-address" />
        <div className="tv-code-big">{view.code}</div>
      </div>
      <div className="tv-lobby-side">
        <h1 className="tv-headline">
          <span className="side-a-text">This</span> or <span className="side-b-text">That</span>?
        </h1>
        <p className="tv-sub">Scan to join. Vote on your phone; see how the room splits.</p>
        <p className="tv-count">{view.players.length === 1 ? "1 player in" : `${view.players.length} players in`}</p>
        <ul className="tv-names">
          {view.players.slice(0, 40).map((p) => (
            <li key={p.id}>{p.name}</li>
          ))}
          {view.players.length > 40 && <li>+{view.players.length - 40} more</li>}
        </ul>
        {view.settings.scoring && <p className="tv-sub">Points for picking what most of the room picks!</p>}
      </div>
    </div>
  );
}

function TvQuestion({ view, skew }: { view: RoomView; skew: number }) {
  const q = view.question!;
  const r = view.phase === "reveal" ? view.result : undefined;
  const now = useTick(!!view.nextAt, 500);
  const card = (c: Choice) => {
    const win = r && (r.majority === c || r.majority === "tie");
    const pct = r ? percent(r.tally[c], r.tally.total) : undefined;
    return (
      <div className={`tv-side tv-side-${c} ${r ? (win ? "win" : "lose") : ""} ${q[c].image ? "has-img" : ""}`}>
        <SideImage side={q[c]} className="tv-side-img" />
        <span className="tv-side-label">{q[c].label}</span>
        {r && <span className="tv-side-pct">{pct}%</span>}
      </div>
    );
  };
  return (
    <div className="tv-q">
      {q.prompt && <p className="tv-prompt">{q.prompt}</p>}
      <div className="tv-sides">
        {card("a")}
        <div className="tv-or">
          {view.phase === "question" ? <Countdown endsAt={view.endsAt} skew={skew} total={view.settings.timerSeconds} className="tv-countdown" /> : <span>or</span>}
        </div>
        {card("b")}
      </div>
      <div className="tv-bar">
        {r ? (
          <SplitBar tally={r.tally} revealed labels={[q.a.label, q.b.label]} />
        ) : view.tally ? (
          <SplitBar tally={view.tally} revealed={false} live labels={[q.a.label, q.b.label]} />
        ) : (
          <SplitBar revealed={false} />
        )}
      </div>
      <div className="tv-status">
        {r ? (
          <span className="tv-quip">{quip(r)}</span>
        ) : (
          <span>
            {view.voters > 0 ? `${view.votes} of ${view.voters} voted` : `${view.votes} ${view.votes === 1 ? "vote" : "votes"} in`}
            {view.settings.scoring ? " · the split stays secret until the reveal" : ""}
          </span>
        )}
      </div>
      {r && view.settings.scoring && view.players.length > 0 && (
        <div className="tv-mini-board">
          <Scoreboard players={view.players} scoring streaks={view.settings.streaks} limit={5} />
        </div>
      )}
      {r && view.nextAt && <p className="tv-next">Next question in {secondsLeft(view.nextAt, skew, now)}…</p>}
    </div>
  );
}

/** Closest to 50/50, and the most one-sided, among questions with at least 2 votes. */
function highlights(history: RoundResult[]) {
  const voted = history.filter((h) => h.tally.total >= 2);
  const lean = (h: RoundResult) => Math.abs(h.tally.a - h.tally.b) / h.tally.total;
  const divisive = [...voted].sort((x, y) => lean(x) - lean(y))[0];
  const unanimous = [...voted].sort((x, y) => lean(y) - lean(x))[0];
  return { divisive, unanimous: unanimous && unanimous !== divisive ? unanimous : undefined };
}

function TvOver({ view }: { view: RoomView }) {
  const s = view.settings;
  const { divisive, unanimous } = highlights(view.history);
  const line = (h: RoundResult) => {
    const big: Choice = h.tally.a >= h.tally.b ? "a" : "b";
    return (
      <>
        <span className="side-a-text">{h.question.a.label}</span> or <span className="side-b-text">{h.question.b.label}</span>:{" "}
        {percent(h.tally[big], h.tally.total)}% {h.question[big].label}
      </>
    );
  };
  return (
    <div className="tv-over">
      <h1 className="tv-headline">That's a wrap!</h1>
      {s.scoring && view.players.length > 0 ? (
        <div className="tv-final">
          <p className="tv-sub">Best at reading the room</p>
          <Scoreboard players={view.players} scoring streaks={s.streaks} limit={8} />
        </div>
      ) : (
        <p className="tv-sub">{view.history.length} questions answered</p>
      )}
      <div className="tv-highlights">
        {divisive && (
          <p>
            <strong>Most divisive:</strong> {line(divisive)}
          </p>
        )}
        {unanimous && (
          <p>
            <strong>Most agreed:</strong> {line(unanimous)}
          </p>
        )}
      </div>
    </div>
  );
}

/** The host running the game from this big screen (an iPad or laptop on a TV). */
function TvControls({ view, act, onHostControls }: { view: RoomView; act: Act; onHostControls: () => void }) {
  return (
    <nav className="tv-controls">
      {view.phase === "lobby" && (
        <button className="btn btn-primary" onClick={() => act("start")}>
          Start
        </button>
      )}
      {view.phase === "question" && (
        <>
          <button className="btn btn-primary" onClick={() => act("reveal")}>
            Reveal now
          </button>
          <button className="btn btn-ghost" onClick={() => act("skip")}>
            Skip
          </button>
        </>
      )}
      {view.phase === "reveal" && (
        <>
          <button className="btn btn-primary" onClick={() => act("next")}>
            Next question
          </button>
          <button className="btn btn-ghost" onClick={() => act("endGame")}>
            End game
          </button>
        </>
      )}
      {view.phase === "over" && (
        <button className="btn btn-primary" onClick={() => act("start")}>
          Play again
        </button>
      )}
      <button className="btn btn-ghost" onClick={onHostControls}>
        ⚙ Host controls
      </button>
    </nav>
  );
}
