import type { Choice, RoomView } from "@thisorthat/shared";
import { Countdown, Outcome, quip, Scoreboard, SideImage, SplitBar } from "../components/bits";
import type { Act } from "./RoomPage";

/** Two big buttons while voting; how the room split, and how you did, after. */
export function VoteButtons({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const q = view.question!;
  const mine = view.you.choice;
  const button = (c: Choice) => (
    <button className={`vote-btn vote-${c} ${mine === c ? "picked" : ""} ${mine && mine !== c ? "other" : ""}`} onClick={() => void act("vote", c)} aria-pressed={mine === c}>
      <SideImage side={q[c]} />
      <span className="vote-label">{q[c].label}</span>
      {mine === c && <span className="vote-check">✓</span>}
    </button>
  );
  return (
    <section className="vote">
      <div className="vote-head">
        <p className="vote-prompt">{q.prompt ?? `Question ${view.round}`}</p>
        <Countdown endsAt={view.endsAt} skew={skew} total={view.settings.timerSeconds} />
      </div>
      {button("a")}
      <div className="vote-or" aria-hidden>
        or
      </div>
      {button("b")}
      <p className="muted small center">{mine ? "Locked in. You can still change your mind." : "Tap one."}</p>
    </section>
  );
}

export function RevealCard({ view, showYou = true }: { view: RoomView; showYou?: boolean }) {
  const r = view.result!;
  const q = r.question;
  const you = view.you;
  const picked = you.choice ? q[you.choice].label : undefined;
  return (
    <section className="reveal">
      <p className="reveal-q">
        <span className="side-a-text">{q.a.label}</span> or <span className="side-b-text">{q.b.label}</span>
      </p>
      <SplitBar tally={r.tally} revealed labels={[q.a.label, q.b.label]} />
      <p className="reveal-quip">{quip(r)}</p>
      {showYou &&
        (picked ? (
          <div className={`you-result ${you.scored ? "you-scored" : ""}`}>
            <p className="you-big">
              You picked <strong className={`side-${you.choice}-text`}>{picked}</strong>: {you.agreed}% agreed
            </p>
            {view.settings.scoring && <p>{you.scored ? "+1 point: you read the room!" : "No point this time: the room went the other way."}</p>}
            {view.settings.streaks && you.streak >= 2 && <p className="streak-big">🔥 {you.streak} in a row with the majority</p>}
          </div>
        ) : (
          <p className="muted center">You didn't vote on this one.</p>
        ))}
    </section>
  );
}

export function PlayerView({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const s = view.settings;
  return (
    <main className="player">
      {view.phase === "lobby" && (
        <section className="panel center">
          <h2>You're in, {view.you.name}!</h2>
          <p className="muted">Waiting for the host to start. Watch the TV.</p>
          <p className="muted small">{view.players.length} playing</p>
        </section>
      )}
      {view.phase === "question" && view.question && <VoteButtons view={view} skew={skew} act={act} />}
      {view.phase === "reveal" && view.result && <RevealCard view={view} />}
      {view.phase === "over" && (
        <section className="panel center">
          <h2>That's a wrap!</h2>
          {s.scoring ? (
            <>
              <Outcome view={view} />
              <p className="you-big">
                You got {view.you.score} of {view.history.length} with the majority
              </p>
              <Scoreboard players={view.players} scoring streaks={s.streaks} limit={10} highlight={view.you.id} />
            </>
          ) : (
            <p className="muted">{view.history.length} questions. Thanks for playing!</p>
          )}
          {s.streaks && view.you.bestStreak >= 2 && <p className="streak-big">Best streak: 🔥 {view.you.bestStreak}</p>}
          <p className="muted small">Stay here: the host can start another round.</p>
        </section>
      )}
      {view.phase !== "over" && s.scoring && view.phase !== "lobby" && (
        <p className="muted small center you-score">
          Your score: {view.you.score}
          {s.streaks && view.you.streak >= 2 ? ` · 🔥 ${view.you.streak}` : ""}
        </p>
      )}
    </main>
  );
}
