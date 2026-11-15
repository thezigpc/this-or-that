// Socket protocol, views and settings shared by the server and the client.

export const DEFAULT_GAME_NAME = "This or That";

/** host: runs the room; cohost: runs the game (can't close it or remove anyone); table: the TV. */
export type Role = "host" | "cohost" | "player" | "table";
export type Phase = "lobby" | "question" | "reveal" | "over";
export type Choice = "a" | "b";

/** One side of a question. `image` is an https URL or a path on the game ("media/…"). */
export interface Side {
  label: string;
  image?: string;
}

export interface Question {
  id: string;
  /** Optional lead-in ("Friday night:"). The sides are the question. */
  prompt?: string;
  a: Side;
  b: Side;
}

export interface RoomSettings {
  /** Voting time per question. */
  timerSeconds: number;
  /** "Guess the majority": a point for picking what most people picked. */
  scoring: boolean;
  /** Show streaks of consecutive majority picks (with scoring). */
  streaks: boolean;
  /** Questions per game; 0 = until the packs run out. */
  rounds: number;
  /** Move on by itself this many seconds after a reveal; 0 = wait for the host. */
  autoNextSeconds: number;
  /** Packs the questions come from (shuffled together). */
  packIds: string[];
}

export const SETTINGS_LIMITS = {
  timerSeconds: { min: 3, max: 60 },
  rounds: { min: 0, max: 100 },
  autoNextSeconds: { min: 0, max: 60 },
} as const;

export const TIMER_CHOICES = [5, 8, 10, 15, 20, 30];
export const ROUND_CHOICES = [5, 10, 15, 20, 0];
export const AUTO_NEXT_CHOICES = [0, 5, 8, 12];

export const SAMPLE_PACK_ID = "sample";

export const DEFAULT_SETTINGS: RoomSettings = {
  timerSeconds: 10,
  scoring: false,
  streaks: true,
  rounds: 10,
  autoNextSeconds: 0,
  packIds: [SAMPLE_PACK_ID],
};

export interface PackInfo {
  id: string;
  name: string;
  count: number;
  builtIn: boolean;
}

export interface Tally {
  a: number;
  b: number;
  total: number;
}

/** How a question came out. majority: the bigger side, "tie", or null when nobody voted. */
export interface RoundResult {
  round: number;
  question: Question;
  tally: Tally;
  majority: Choice | "tie" | null;
}

export interface ScoreLine {
  id: string;
  name: string;
  score: number;
  streak: number;
  bestStreak: number;
  connected: boolean;
}

export interface RoomView {
  code: string;
  title?: string;
  phase: Phase;
  /** Questions asked so far in this game (the current one included). */
  round: number;
  settings: RoomSettings;
  /** The question being voted on or revealed. */
  question?: Question;
  /** Voting closes at (server ms). */
  endsAt?: number;
  /** Reveal: when the next question starts by itself (server ms). */
  nextAt?: number;
  /**
   * The live split. Sent to TVs and hosts while voting, unless scoring is on (then it
   * stays hidden until the reveal, so nobody can follow the crowd); always in the reveal.
   */
  tally?: Tally;
  /** Votes in so far (always sent while voting). */
  votes: number;
  /** Players who can vote right now (connected players). */
  voters: number;
  result?: RoundResult;
  /** Players by score (score order when scoring is on, join order otherwise). */
  players: ScoreLine[];
  /** Every finished question of this game, for the end screen. */
  history: RoundResult[];
  /** Questions left in the deck (packs) and typed by the host, waiting. */
  remaining: number;
  queued: number;
  packs: PackInfo[];
  hostName?: string;
  /** Host only: the co-hosts, to remove one. */
  cohosts?: { id: string; name: string }[];
  you: {
    id: string;
    role: Role;
    name: string;
    choice?: Choice;
    /** Reveal: percent of voters who picked what you picked. */
    agreed?: number;
    /** Reveal with scoring: you picked the majority. */
    scored?: boolean;
    score: number;
    streak: number;
    bestStreak: number;
  };
  serverTime: number;
}

export interface JoinResult {
  code: string;
  token: string;
  memberId: string;
  role: Role;
  name: string;
}

/** A question the host types live. Images are data: URLs from the phone (resized). */
export interface AskRequest {
  prompt?: string;
  a: string;
  b: string;
  aImage?: string;
  bImage?: string;
}

export const ERRORS = {
  BAD_REQUEST: "That request wasn't valid.",
  ROOM_NOT_FOUND: "There's no room with that code.",
  ROOM_FULL: "That room (or the server) is full right now.",
  NOT_IN_ROOM: "You're not in a room. Join one first.",
  NOT_HOST: "Only the host can do that.",
  NOT_VOTING: "Voting has closed for this question.",
  NAME_REQUIRED: "Enter your name.",
  NAME_TAKEN: "Someone in the room already has that name.",
  BAD_TOKEN: "Your seat in this room has expired. Join again.",
  BAD_INVITE: "That co-host link has already been used or has expired. Ask the host for a new one.",
  RATE_LIMITED: "Too many attempts. Wait a minute and try again.",
  WRONG_PHASE: "That can't be done right now.",
  NO_QUESTIONS: "There are no questions left. Pick more packs or type your own.",
  BAD_QUESTION: "Give both sides a name (up to 60 characters).",
  BAD_IMAGE: "That picture couldn't be used. Try a JPEG or PNG under 600 KB.",
} as const;

export const ADMIN_SETTINGS_LIMITS = {
  roomIdleMinutes: { min: 5, max: 7 * 24 * 60 },
} as const;

export interface AdminSettings {
  roomIdleMinutes: number;
  /** Defaults for new rooms. */
  roomDefaults: RoomSettings;
}

export interface AdminRoomSummary {
  code: string;
  kind: string;
  phase: Phase;
  round: number;
  players: number;
  tables: number;
  hostName?: string;
  createdAt: number;
  lastActivityAt: number;
}

export interface AdminOverview {
  rooms: AdminRoomSummary[];
  settings: AdminSettings;
  packs: PackInfo[];
  media: MediaInfo[];
  serverTime: number;
}

export interface MediaInfo {
  name: string;
  /** Path on the game: "media/<name>". */
  path: string;
  bytes: number;
}

// ---------------------------------------------------------------- validation

const clampInt = (v: unknown, min: number, max: number): number | undefined => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

/**
 * Cleans a settings patch: unknown keys dropped, bad values dropped (not thrown), so a
 * device or admin default from an older version never breaks room creation.
 */
export function sanitizeSettings(raw: unknown, knownPacks?: (id: string) => boolean): Partial<RoomSettings> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: Partial<RoomSettings> = {};
  const t = clampInt(r.timerSeconds, SETTINGS_LIMITS.timerSeconds.min, SETTINGS_LIMITS.timerSeconds.max);
  if (t !== undefined) out.timerSeconds = t;
  const rounds = clampInt(r.rounds, SETTINGS_LIMITS.rounds.min, SETTINGS_LIMITS.rounds.max);
  if (rounds !== undefined) out.rounds = rounds;
  const auto = clampInt(r.autoNextSeconds, SETTINGS_LIMITS.autoNextSeconds.min, SETTINGS_LIMITS.autoNextSeconds.max);
  if (auto !== undefined) out.autoNextSeconds = auto;
  if (typeof r.scoring === "boolean") out.scoring = r.scoring;
  if (typeof r.streaks === "boolean") out.streaks = r.streaks;
  if (Array.isArray(r.packIds)) {
    const ids = [...new Set(r.packIds.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64))]
      .filter((id) => !knownPacks || knownPacks(id))
      .slice(0, 50);
    out.packIds = ids;
  }
  return out;
}

/** Tally → majority side. */
export function majorityOf(t: Tally): Choice | "tie" | null {
  if (t.total === 0) return null;
  return t.a > t.b ? "a" : t.b > t.a ? "b" : "tie";
}

/** Whole percent of `n` out of `total` (0 when nobody voted). */
export const percent = (n: number, total: number): number => (total > 0 ? Math.round((n / total) * 100) : 0);
