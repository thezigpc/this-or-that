// One room: the server-authoritative state machine.
//
//   lobby ──start──▶ question ──(timer / everyone voted / reveal now)──▶ reveal ──next──▶ question …
//                       │ skip: drop it, ask the next one                    │
//                       └──────────────── end game / rounds done ────────────┴──▶ over ──play again──▶ question
//
// Clients send intents and render the view they're sent; nothing is decided on a phone.

import {
  DEFAULT_SETTINGS,
  majorityOf,
  percent,
  sanitizeSettings,
  type AdminRoomSummary,
  type AskRequest,
  type Choice,
  type Phase,
  type Question,
  type Role,
  type RoomSettings,
  type RoomView,
  type RoundResult,
  type ScoreLine,
  type Side,
  type Tally,
} from "@thisorthat/shared";
import { HostSeats, cryptoRand, log, newId, newToken, safeTimeout, type CloseCause, type KitRoom, type RoomOverview, type SessionKind } from "@bargames/gamekit/server";
import { bg } from "../bargames.js";
import { ALL_VOTED_GRACE_MS, MAX_PLAYERS_PER_ROOM, MAX_TABLES_PER_ROOM } from "../config.js";
import { hasPack, imageType, listPacks, packQuestions } from "../content.js";
import { GameError } from "./errors.js";

export interface Member {
  id: string;
  token: string;
  role: Role;
  name: string;
  socketIds: Set<string>;
  score: number;
  streak: number;
  bestStreak: number;
  /** Questions this member voted on this game (runners show on the board once they vote). */
  votedRounds: number;
  joinedAt: number;
}

/** How the room talks to sockets: injected so Room has no socket.io dependency. */
export interface RoomTransport {
  sendState(socketId: string, view: RoomView): void;
  sendClosed(socketId: string, reason: string): void;
  sendNotice(socketId: string, message: string): void;
}

/** The host key's link and co-host invites (the box's host_link / cohost_link too). */
export const hostPath = (room: { code: string }, token: string) => `/join/${room.code}?host=${encodeURIComponent(token)}`;
export const cohostPath = (room: { code: string }, token: string) => `/join/${room.code}?cohost=${encodeURIComponent(token)}`;

export const TAKEOVER_NOTICE = "Staff took over hosting. You're a co-host now: you can still run the game.";
export const COHOST_REMOVED_NOTICE = "You're not a co-host any more.";

/** Pictures the host attaches to live questions, kept in memory per room. */
export const MAX_ROOM_IMAGES = 24;
export const MAX_ROOM_IMAGE_BYTES = 600 * 1024;
const MAX_HISTORY = 100;
const MAX_QUEUE = 20;
const NAME_MAX = 24;

const cleanName = (raw: unknown) => (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "");
const cleanLabel = (raw: unknown, max: number) => (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, max) : "");

function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = cryptoRand(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** "data:image/jpeg;base64,…" → bytes, if it's a real png/jpeg/gif/webp within the limit. */
export function decodeImage(dataUrl: unknown): { mime: string; data: Buffer } | undefined {
  if (typeof dataUrl !== "string") return undefined;
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return undefined;
  const data = Buffer.from(m[2]!, "base64");
  const type = imageType(data);
  if (!type || data.length > MAX_ROOM_IMAGE_BYTES) return undefined;
  return { mime: type.mime, data };
}

const label = (q: Question) => `${q.prompt ? `${q.prompt} ` : ""}${q.a.label} or ${q.b.label}?`;

export class Room implements KitRoom {
  readonly members = new Map<string, Member>();
  hostId = "";
  seats = new HostSeats();
  phase: Phase = "lobby";
  /** Questions asked this game, the current one included. */
  round = 0;
  settings: RoomSettings = { ...DEFAULT_SETTINGS };
  question?: Question;
  endsAt?: number;
  nextAt?: number;
  result?: RoundResult;
  history: RoundResult[] = [];
  private readonly votes = new Map<string, Choice>();
  /** The packs' questions not asked yet, shuffled. */
  private deck: Question[] = [];
  /** Questions the host typed, asked before the deck. */
  private queue: Question[] = [];
  /** Question ids already asked in this room (any game), so a replay brings new ones first. */
  private readonly asked = new Set<string>();
  readonly images = new Map<string, { mime: string; data: Buffer }>();
  private liveCount = 0;
  private voteTimer?: NodeJS.Timeout;
  private nextTimer?: NodeJS.Timeout;
  private allVotedTimer?: NodeJS.Timeout;
  lastActivityAt = Date.now();
  readonly createdAt = Date.now();
  closed = false;
  kind: SessionKind;
  title?: string;

  onFatalError: (err: unknown) => void = () => {};
  onPlayersChanged: () => void = () => {};

  constructor(
    readonly code: string,
    private readonly transport: RoomTransport,
    kind: SessionKind = "patron",
  ) {
    this.kind = kind;
  }

  private touch() {
    this.lastActivityAt = Date.now();
  }

  // ------------------------------------------------------------- members

  addHost(name: string): Member {
    const m = this.newMember("host", cleanName(name) || "Host");
    this.hostId = m.id;
    return m;
  }

  /** The first phone into a "first joiner hosts" room takes the host seat, under its name. */
  claimHostSeat(rawName: unknown): Member {
    const host = this.members.get(this.hostId);
    const name = cleanName(rawName);
    if (!name) throw new GameError("NAME_REQUIRED");
    if (!host || this.seats.claimForJoiner() !== "host") throw new GameError("BAD_REQUEST");
    host.name = name;
    return host;
  }

  /** The seat a token opens: a member's own token, or the host key (the host seat). */
  seatFor(token: unknown): Member | undefined {
    if (typeof token !== "string" || !token) return undefined;
    return this.findByToken(token) ?? (this.seats.isHostToken(token) ? this.members.get(this.hostId) : undefined);
  }

  /** Anyone attached to a seat. For the host seat this closes the first-joiner offer. */
  noteAttached(member: Member): void {
    if (member.role === "host") this.seats.hostAttached(member.id);
  }

  cohosts(): Member[] {
    return [...this.members.values()].filter((m) => m.role === "cohost");
  }

  /** A redeemed co-host invite: a new co-host, or a player already here promoted. */
  seatCohost(existing: Member | undefined, rawName: unknown): Member {
    if (existing && existing.role !== "player") return existing;
    let m = existing;
    if (m) {
      m.role = "cohost";
      this.playersChanged();
    } else {
      const name = cleanName(rawName);
      if (!name) throw new GameError("NAME_REQUIRED");
      if (this.nameTaken(name)) throw new GameError("NAME_TAKEN");
      if (this.cohosts().length >= 20) throw new GameError("ROOM_FULL");
      m = this.newMember("cohost", name);
    }
    this.seats.addCohost(m.id);
    return m;
  }

  /** Staff took over (host_link): the old host's phone stays on as a co-host. */
  takeOver(previous: string | undefined): void {
    const old = previous ? this.members.get(previous) : undefined;
    if (!old || old.role !== "host") return;
    old.role = "cohost";
    this.hostId = this.newMember("host", "Venue").id;
    this.notify(old, TAKEOVER_NOTICE);
  }

  /** A co-host is a player again. */
  demoteCohost(memberId: string): void {
    const m = this.members.get(memberId);
    this.seats.removeCohost(memberId);
    if (!m || m.role !== "cohost") return;
    m.role = "player";
    this.playersChanged();
    this.notify(m, COHOST_REMOVED_NOTICE);
  }

  private nameTaken(name: string, except?: string): boolean {
    const n = name.toLowerCase();
    return [...this.members.values()].some((m) => m.id !== except && m.role !== "table" && m.name.toLowerCase() === n);
  }

  private notify(m: Member, message: string): void {
    for (const sid of m.socketIds) this.transport.sendNotice(sid, message);
  }

  addMember(role: "player" | "table", rawName: unknown): Member {
    this.touch();
    if (role === "table") {
      if (this.tables().length >= MAX_TABLES_PER_ROOM) throw new GameError("ROOM_FULL");
      return this.newMember("table", "TV");
    }
    const name = cleanName(rawName);
    if (!name) throw new GameError("NAME_REQUIRED");
    if (this.players().length >= MAX_PLAYERS_PER_ROOM) throw new GameError("ROOM_FULL");
    if (this.nameTaken(name)) throw new GameError("NAME_TAKEN");
    const m = this.newMember("player", name);
    this.playersChanged();
    return m;
  }

  private newMember(role: Role, name: string): Member {
    const m: Member = { id: newId(), token: newToken(), role, name, socketIds: new Set(), score: 0, streak: 0, bestStreak: 0, votedRounds: 0, joinedAt: Date.now() };
    this.members.set(m.id, m);
    return m;
  }

  findByToken(token: string): Member | undefined {
    for (const m of this.members.values()) if (m.token === token) return m;
    return undefined;
  }

  attachSocket(member: Member, socketId: string): void {
    member.socketIds.add(socketId);
  }

  detachSocket(memberId: string, socketId: string): void {
    this.members.get(memberId)?.socketIds.delete(socketId);
  }

  removeMember(memberId: string, reason: string): void {
    const m = this.members.get(memberId);
    if (!m) return;
    for (const sid of m.socketIds) this.transport.sendClosed(sid, reason);
    this.members.delete(memberId);
    this.votes.delete(memberId);
    this.seats.removeCohost(memberId);
    if (m.role === "player") this.playersChanged();
  }

  players(): Member[] {
    return [...this.members.values()].filter((m) => m.role === "player");
  }

  tables(): Member[] {
    return [...this.members.values()].filter((m) => m.role === "table");
  }

  private playersChanged(): void {
    if (!this.closed) this.onPlayersChanged();
  }

  /** Host or co-host: runs the game and its settings. */
  requireRunner(memberId: string): void {
    if (!this.seats.canRun(memberId)) throw new GameError("NOT_HOST");
  }

  /** The host only: closing the room, removing people, co-host invites. */
  requireHost(memberId: string): void {
    if (this.seats.roleOf(memberId) !== "host") throw new GameError("NOT_HOST");
  }

  // ------------------------------------------------------------ the KitRoom

  playerCount(): number {
    return this.players().length;
  }

  tableCount(): number {
    return this.tables().filter((m) => m.socketIds.size > 0).length;
  }

  hostConnected(): boolean {
    return (this.members.get(this.hostId)?.socketIds.size ?? 0) > 0;
  }

  hostName(): string | undefined {
    return this.members.get(this.hostId)?.name;
  }

  maxPlayers(): number {
    return MAX_PLAYERS_PER_ROOM;
  }

  overviewExtra(): Partial<RoomOverview> {
    const what = this.phase === "lobby" ? "Lobby" : this.phase === "over" ? `Finished after ${this.history.length} questions` : `Question ${this.round}${this.question ? `: ${label(this.question)}` : ""}`;
    return { title: `${this.title ? `${this.title} · ` : ""}${what}`.slice(0, 120) };
  }

  summary(): AdminRoomSummary {
    return {
      code: this.code,
      kind: this.kind,
      phase: this.phase,
      round: this.round,
      players: this.playerCount(),
      tables: this.tableCount(),
      hostName: this.hostName(),
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
    };
  }

  // ------------------------------------------------------------ settings

  updateSettings(patch: unknown): void {
    this.touch();
    const clean = sanitizeSettings(patch, hasPack);
    const packsChanged = clean.packIds !== undefined && clean.packIds.join() !== this.settings.packIds.join();
    this.settings = { ...this.settings, ...clean };
    if (!this.settings.packIds.length && !packsChanged) this.settings.packIds = [...DEFAULT_SETTINGS.packIds];
    if (packsChanged) this.buildDeck();
    // Auto-next turned off during a reveal: stop the pending move on.
    if (clean.autoNextSeconds === 0 && this.nextTimer) {
      clearTimeout(this.nextTimer);
      this.nextTimer = undefined;
      this.nextAt = undefined;
    }
  }

  /** How many questions the chosen packs hold (before a game builds its deck). */
  private packTotal(): number {
    const ids = new Set<string>();
    for (const id of this.settings.packIds) for (const q of packQuestions(id)) ids.add(q.id);
    return ids.size;
  }

  /** The chosen packs' questions, shuffled; ones this room has asked go to the back. */
  private buildDeck(): void {
    const seen = new Set<string>();
    const all: Question[] = [];
    for (const id of this.settings.packIds) {
      for (const q of packQuestions(id)) {
        if (!seen.has(q.id)) {
          seen.add(q.id);
          all.push(q);
        }
      }
    }
    const fresh = shuffle(all.filter((q) => !this.asked.has(q.id) && q.id !== this.question?.id));
    const again = shuffle(all.filter((q) => this.asked.has(q.id) && q.id !== this.question?.id));
    this.deck = [...fresh, ...again];
  }

  // ------------------------------------------------------------ the game

  private clearTimers(): void {
    clearTimeout(this.voteTimer);
    clearTimeout(this.nextTimer);
    clearTimeout(this.allVotedTimer);
    this.voteTimer = this.nextTimer = this.allVotedTimer = undefined;
  }

  private timer(label: string, ms: number, fn: () => void): NodeJS.Timeout {
    return safeTimeout(
      label,
      ms,
      () => {
        if (this.closed) return;
        fn();
        this.broadcast();
      },
      this.onFatalError,
    );
  }

  private emit(type: "round_started" | "round_ended" | "winner" | "game_over", data: Record<string, unknown>): void {
    bg.emit({ type, roomCode: this.code, sessionKind: this.kind, data });
  }

  /** Start a game (from the lobby) or a new one (from the end screen): scores reset. */
  start(): void {
    if (this.phase !== "lobby" && this.phase !== "over") throw new GameError("WRONG_PHASE");
    this.touch();
    this.clearTimers();
    this.round = 0;
    this.history = [];
    this.result = undefined;
    this.question = undefined;
    for (const m of this.members.values()) {
      m.score = 0;
      m.streak = 0;
      m.bestStreak = 0;
      m.votedRounds = 0;
    }
    this.buildDeck();
    if (!this.queue.length && !this.deck.length) throw new GameError("NO_QUESTIONS");
    this.askNext();
  }

  /** The host's Next (and the box's next_round): on from a reveal, or reveal now while voting. */
  next(): void {
    this.touch();
    if (this.phase === "question") return this.reveal();
    if (this.phase === "reveal") return this.askNext();
    this.start();
  }

  /** Puts the next question up (typed ones first), or ends the game when it's done. */
  private askNext(): void {
    this.clearTimers();
    this.nextAt = undefined;
    const limitReached = this.settings.rounds > 0 && this.round >= this.settings.rounds;
    const q = limitReached ? undefined : (this.queue.shift() ?? this.deck.shift());
    if (!q) {
      if (this.round > 0) return this.finish();
      throw new GameError("NO_QUESTIONS");
    }
    this.round++;
    this.question = q;
    this.asked.add(q.id);
    this.result = undefined;
    this.votes.clear();
    this.phase = "question";
    const ms = this.settings.timerSeconds * 1000;
    this.endsAt = Date.now() + ms;
    this.voteTimer = this.timer("vote", ms, () => this.reveal());
    this.emit("round_started", { round: this.round, question: label(q) });
  }

  vote(memberId: string, choice: unknown): void {
    if (this.phase !== "question") throw new GameError("NOT_VOTING");
    if (choice !== "a" && choice !== "b") throw new GameError("BAD_REQUEST");
    const m = this.members.get(memberId);
    if (!m || m.role === "table") throw new GameError("BAD_REQUEST");
    this.touch();
    this.votes.set(memberId, choice);
    // Everyone who can vote has: reveal after a short beat (votes can still change in it).
    clearTimeout(this.allVotedTimer);
    this.allVotedTimer = undefined;
    const voters = this.players().filter((p) => p.socketIds.size > 0);
    if (voters.length > 0 && voters.every((p) => this.votes.has(p.id))) {
      this.allVotedTimer = this.timer("all-voted", ALL_VOTED_GRACE_MS, () => this.reveal());
    }
  }

  private tally(): Tally {
    let a = 0;
    let b = 0;
    for (const [id, c] of this.votes) {
      if (!this.members.has(id)) continue;
      if (c === "a") a++;
      else b++;
    }
    return { a, b, total: a + b };
  }

  /** Voting closes: count, score, and show how the room split. */
  reveal(): void {
    if (this.phase !== "question" || !this.question) throw new GameError("WRONG_PHASE");
    this.clearTimers();
    const tally = this.tally();
    const majority = majorityOf(tally);
    const result: RoundResult = { round: this.round, question: this.question, tally, majority };
    for (const m of this.members.values()) {
      if (m.role === "table") continue;
      const c = this.votes.get(m.id);
      if (c) m.votedRounds++;
      // Guess the majority: a tie counts for both sides. Not voting breaks a streak.
      const right = !!c && (majority === "tie" || c === majority);
      if (this.settings.scoring && right) m.score++;
      m.streak = right ? m.streak + 1 : 0;
      m.bestStreak = Math.max(m.bestStreak, m.streak);
    }
    this.result = result;
    this.history.push(result);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.phase = "reveal";
    this.endsAt = undefined;
    this.emit("round_ended", { round: this.round, question: label(this.question), a: tally.a, b: tally.b, votes: tally.total, majority });
    if (this.settings.autoNextSeconds > 0) {
      const ms = this.settings.autoNextSeconds * 1000;
      this.nextAt = Date.now() + ms;
      this.nextTimer = this.timer("auto-next", ms, () => this.askNext());
    }
  }

  /** Drop the question on screen without counting it, and ask the next one. */
  skip(): void {
    this.touch();
    if (this.phase === "reveal") return this.askNext();
    if (this.phase !== "question") throw new GameError("WRONG_PHASE");
    this.clearTimers();
    this.votes.clear();
    this.round--;
    this.question = undefined;
    this.askNext();
  }

  /** The host's End game: straight to the end screen (a question being voted on isn't counted). */
  endGame(): void {
    if (this.phase !== "question" && this.phase !== "reveal") throw new GameError("WRONG_PHASE");
    this.touch();
    if (this.phase === "question") this.round--;
    this.finish();
  }

  /** Who won (scoring on): everyone tied on the top score, if anyone scored. */
  winners(): Member[] {
    if (!this.settings.scoring) return [];
    const scored = this.scoreboardMembers();
    const top = Math.max(0, ...scored.map((m) => m.score));
    return top > 0 ? scored.filter((m) => m.score === top) : [];
  }

  private finish(): void {
    this.clearTimers();
    this.phase = "over";
    this.question = undefined;
    this.endsAt = undefined;
    this.nextAt = undefined;
    this.votes.clear();
    const winners = this.winners();
    for (const w of winners) this.emit("winner", { name: w.name, score: w.score });
    this.emit("game_over", { rounds: this.history.length, ...(winners.length ? { winners: winners.map((w) => w.name) } : {}) });
    if (this.settings.scoring && this.history.length > 0) {
      // Competition ranking: 1, 1, 3. Only people who voted at least once.
      const board = this.scoreboardMembers().filter((m) => m.votedRounds > 0).sort((a, b) => b.score - a.score);
      const results = board.map((m) => ({ player: { name: m.name }, place: 1 + board.filter((o) => o.score > m.score).length, score: m.score }));
      if (results.length) void bg.reportResults({ roomCode: this.code, results }).catch(() => undefined);
    }
    log.info("room", "game over", { code: this.code, rounds: this.history.length, winners: winners.length });
  }

  /** A question the host types live: up next (or right away between questions). */
  ask(req: AskRequest): { now: boolean } {
    this.touch();
    const r = (req ?? {}) as AskRequest;
    const a = cleanLabel(r.a, 60);
    const b = cleanLabel(r.b, 60);
    if (!a || !b) throw new GameError("BAD_QUESTION");
    if (this.queue.length >= MAX_QUEUE) throw new GameError("ROOM_FULL");
    const side = (labelText: string, img: unknown): Side => {
      if (img === undefined || img === null || img === "") return { label: labelText };
      const decoded = decodeImage(img);
      if (!decoded) throw new GameError("BAD_IMAGE");
      return { label: labelText, image: this.storeImage(decoded) };
    };
    const prompt = cleanLabel(r.prompt, 80);
    const q: Question = { id: `live-${++this.liveCount}`, ...(prompt ? { prompt } : {}), a: side(a, r.aImage), b: side(b, r.bImage) };
    this.queue.push(q);
    log.info("room", "live question", { code: this.code, queued: this.queue.length });
    // Between questions: ask it now. While voting or on the end screen: it's next.
    if (this.phase === "lobby") {
      this.start();
      return { now: true };
    }
    if (this.phase === "reveal") {
      this.queue.unshift(this.queue.pop()!);
      this.askNext();
      return { now: true };
    }
    return { now: false };
  }

  private storeImage(img: { mime: string; data: Buffer }): string {
    while (this.images.size >= MAX_ROOM_IMAGES) this.images.delete(this.images.keys().next().value!);
    const id = newId();
    this.images.set(id, img);
    return `media/room/${this.code}/${id}`;
  }

  // ------------------------------------------------------------ views

  private scoreboardMembers(): Member[] {
    return [...this.members.values()].filter((m) => m.role === "player" || ((m.role === "host" || m.role === "cohost") && m.votedRounds > 0));
  }

  private scoreLines(): ScoreLine[] {
    const list = this.scoreboardMembers();
    if (this.settings.scoring) list.sort((a, b) => b.score - a.score || b.bestStreak - a.bestStreak || a.joinedAt - b.joinedAt);
    else list.sort((a, b) => a.joinedAt - b.joinedAt);
    return list.map((m) => ({ id: m.id, name: m.name, score: m.score, streak: m.streak, bestStreak: m.bestStreak, connected: m.socketIds.size > 0 }));
  }

  view(m: Member): RoomView {
    const tally = this.phase === "question" ? this.tally() : undefined;
    const choice = this.phase === "question" ? this.votes.get(m.id) : this.phase === "reveal" ? this.lastVote(m.id) : undefined;
    const r = this.phase === "reveal" ? this.result : undefined;
    const runner = m.role === "host" || m.role === "cohost";
    // The live split: TVs and hosts, unless scoring is on (then nobody can follow the crowd).
    const liveTally = this.phase === "question" && m.role !== "player" && !this.settings.scoring;
    const connectedPlayers = this.players().filter((p) => p.socketIds.size > 0);
    const runnerVotes = [...this.votes.keys()].filter((id) => {
      const x = this.members.get(id);
      return x && x.role !== "player";
    }).length;
    return {
      code: this.code,
      title: this.title,
      phase: this.phase,
      round: this.round,
      settings: this.settings,
      question: this.question,
      endsAt: this.endsAt,
      nextAt: this.nextAt,
      tally: r ? r.tally : liveTally ? tally : undefined,
      votes: tally?.total ?? 0,
      voters: connectedPlayers.length + runnerVotes,
      result: r,
      players: this.scoreLines(),
      history: this.phase === "over" ? this.history : [],
      remaining: this.phase === "lobby" || this.phase === "over" ? this.packTotal() : this.deck.length,
      queued: this.queue.length,
      packs: runner ? listPacks() : [],
      hostName: this.hostName(),
      cohosts: m.role === "host" ? this.cohosts().map((c) => ({ id: c.id, name: c.name })) : undefined,
      you: {
        id: m.id,
        role: m.role,
        name: m.name,
        choice,
        agreed: r && choice ? percent(r.tally[choice], r.tally.total) : undefined,
        scored: r && choice && this.settings.scoring ? r.majority === "tie" || r.majority === choice : undefined,
        score: m.score,
        streak: m.streak,
        bestStreak: m.bestStreak,
      },
      serverTime: Date.now(),
    };
  }

  /** In a reveal the votes are still there (cleared when the next question starts). */
  private lastVote(id: string): Choice | undefined {
    return this.votes.get(id);
  }

  broadcast(): void {
    if (this.closed) return;
    for (const m of this.members.values()) {
      if (!m.socketIds.size) continue;
      const v = this.view(m);
      for (const sid of m.socketIds) this.transport.sendState(sid, v);
    }
  }

  close(reason: string, cause: CloseCause): void {
    if (this.closed) return;
    // Staff or the host ended the session mid-game: it still counts as a finished game.
    if ((cause === "host" || cause === "admin") && (this.phase === "question" || this.phase === "reveal") && this.history.length > 0) {
      if (this.phase === "question") this.round--;
      this.finish();
    }
    this.closed = true;
    this.clearTimers();
    for (const m of this.members.values()) for (const sid of m.socketIds) this.transport.sendClosed(sid, reason);
  }
}

