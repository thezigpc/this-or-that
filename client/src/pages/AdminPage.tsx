import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AUTO_NEXT_CHOICES, ROUND_CHOICES, TIMER_CHOICES, type AdminOverview, type RoomSettings } from "@thisorthat/shared";
import { BoxAdminLink, staffSignIn } from "@bargames/gamekit/client";
import { mediaUrl, serverUrl } from "../socket";
import { useVenue } from "../useVenue";

const TOKEN_KEY = "thisorthat_admin_token";
const loadToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveToken = (t: string) => {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
};

type Init = { method?: string; body?: unknown; raw?: BodyInit; query?: Record<string, string> };

async function api<T>(path: string, token: string, init: Init = {}): Promise<T> {
  const q = init.query ? `?${new URLSearchParams(init.query)}` : "";
  const res = await fetch(`${serverUrl}/api/admin${path}${q}`, {
    method: init.method ?? (init.body !== undefined || init.raw !== undefined ? "POST" : "GET"),
    headers: {
      ...(init.raw === undefined ? { "content-type": "application/json" } : { "content-type": "application/octet-stream" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `Request failed (${res.status}).`), { status: res.status });
  return body as T;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

interface AdminStatus {
  setupNeeded: boolean;
  authenticated: boolean;
  trusted?: boolean;
  venueLogin?: boolean;
  setupAllowed?: boolean;
}

export function AdminPage() {
  const [token, setToken] = useState(loadToken);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const venue = useVenue();

  const refreshStatus = useCallback(() => {
    api<AdminStatus>("/status", token)
      .then(async (s) => {
        // Staff the venue box vouches for (SDK 0.7.0): in without the password. Never off a box.
        if (!s.authenticated && s.trusted && !signedOut) {
          const t = await staffSignIn(serverUrl);
          if (t) {
            saveToken(t);
            setToken(t);
            return;
          }
        }
        setStatus(s);
      })
      .catch((e: Error) => setError(e.message));
  }, [token, signedOut]);
  useEffect(refreshStatus, [refreshStatus]);

  const signedIn = (t: string) => {
    saveToken(t);
    setToken(t);
  };
  const signOut = async () => {
    await api("/logout", token, { method: "POST" }).catch(() => {});
    setSignedOut(true);
    signedIn("");
  };

  return (
    <main className="admin">
      <BoxAdminLink ctx={venue} />
      <header className="admin-head">
        <h1>Admin</h1>
        <Link to="/" className="muted">
          ← Home
        </Link>
      </header>
      {error && <p className="error">{error}</p>}
      {!status ? (
        <p className="muted">Loading…</p>
      ) : status.authenticated ? (
        <Dashboard token={token} onSignOut={signOut} onExpired={() => signedIn("")} />
      ) : (
        <PasswordForm status={status} onToken={signedIn} />
      )}
    </main>
  );
}

function PasswordForm({ status, onToken }: { status: AdminStatus; onToken: (t: string) => void }) {
  const setupNeeded = status.setupNeeded;
  // On a venue box the box's admin password signs in here too (kit 0.5.1); only staff the
  // box vouches for may set a separate password. Standalone this is always false.
  const onBox = status.venueLogin === true;
  const canSetOwn = onBox && setupNeeded && status.setupAllowed === true;
  const [ownPassword, setOwnPassword] = useState(false);
  const setup = setupNeeded && (!onBox || (canSetOwn && ownPassword));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (setup && password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    setError("");
    try {
      const r = await api<{ token: string }>(setup ? "/setup" : "/login", "", { method: "POST", body: { password } });
      onToken(r.token);
    } catch (err) {
      const msg = (err as Error).message;
      setError(onBox && setupNeeded && !setup && /set up/i.test(msg) ? "That isn't the venue's admin password." : msg);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel admin-login" onSubmit={submit}>
      <h2>{setup ? "Set the admin password" : "Sign in"}</h2>
      {onBox && !setup && <p className="muted small">{setupNeeded ? "Use the venue's admin password." : "Use this game's admin password, or the venue's admin password."}</p>}
      {setup && (
        <p className="warning">
          No admin password has been set yet. Whoever sets it first becomes the admin, so do this now. The <code>ADMIN_PASSWORD</code> environment variable overrides it.
        </p>
      )}
      <label>
        Password
        <input type="password" maxLength={200} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? "new-password" : "current-password"} autoFocus />
      </label>
      {setup && (
        <label>
          Confirm password
          <input type="password" maxLength={200} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary btn-big" disabled={busy || password.length === 0}>
        {setup ? "Set password" : "Sign in"}
      </button>
      {canSetOwn && (
        <button type="button" className="btn btn-ghost" onClick={() => setOwnPassword(!ownPassword)}>
          {ownPassword ? "Sign in with the venue's password instead" : "Set a separate password for this game instead"}
        </button>
      )}
    </form>
  );
}

function Dashboard({ token, onSignOut, onExpired }: { token: string; onSignOut: () => void; onExpired: () => void }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [idle, setIdle] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api<AdminOverview>("/overview", token));
    } catch (err) {
      if ((err as { status?: number }).status === 401) onExpired();
      else setError((err as Error).message);
    }
  }, [token, onExpired]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  // Fill the idle minutes once, from the first overview. Refilling whenever the field is empty
  // put the old value back while someone cleared it to type a new one.
  const idleFilled = useRef(false);
  useEffect(() => {
    if (!data || idleFilled.current) return;
    idleFilled.current = true;
    setIdle(String(data.settings.roomIdleMinutes));
  }, [data]);

  const run = async (fn: () => Promise<string | void>) => {
    setError("");
    setNote("");
    try {
      const msg = await fn();
      if (msg) setNote(msg);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (!data) return <p className="muted">Loading…</p>;
  const d = data.settings.roomDefaults;
  const setDefaults = (patch: Partial<RoomSettings>) => run(async () => void (await api("/settings", token, { method: "PUT", body: { roomDefaults: patch } })));

  return (
    <div className="dashboard">
      {error && <p className="error">{error}</p>}
      {note && <p className="note">{note}</p>}

      <section className="panel">
        <h2>Rooms ({data.rooms.length})</h2>
        {data.rooms.length === 0 ? (
          <p className="muted">No rooms open.</p>
        ) : (
          <table className="rooms-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Host</th>
                <th>Phase</th>
                <th>Players</th>
                <th>Last activity</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.rooms.map((r) => (
                <tr key={r.code}>
                  <td className="mono">{r.code}</td>
                  <td>{r.hostName}</td>
                  <td>
                    {r.phase}
                    {r.round ? ` (Q${r.round})` : ""}
                  </td>
                  <td>
                    {r.players}
                    {r.tables ? ` + ${r.tables} TV` : ""}
                  </td>
                  <td>{ago(data.serverTime - r.lastActivityAt)}</td>
                  <td>
                    <button className="link-btn" onClick={() => window.confirm(`Close room ${r.code}?`) && void run(async () => void (await api(`/rooms/${r.code}/close`, token, { method: "POST" })))}>
                      Close
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel settings">
        <h2>New rooms start with</h2>
        <label className="row">
          <span>Time to vote</span>
          <select value={d.timerSeconds} onChange={(e) => void setDefaults({ timerSeconds: Number(e.target.value) })}>
            {[...new Set([...TIMER_CHOICES, d.timerSeconds])].sort((x, y) => x - y).map((t) => (
              <option key={t} value={t}>
                {t} seconds
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <span>Questions per game</span>
          <select value={d.rounds} onChange={(e) => void setDefaults({ rounds: Number(e.target.value) })}>
            {[...new Set([...ROUND_CHOICES, d.rounds])].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "Until they run out" : n}
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <span>After a reveal</span>
          <select value={d.autoNextSeconds} onChange={(e) => void setDefaults({ autoNextSeconds: Number(e.target.value) })}>
            {[...new Set([...AUTO_NEXT_CHOICES, d.autoNextSeconds])].sort((x, y) => x - y).map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "Wait for Next" : `Next by itself after ${n} s`}
              </option>
            ))}
          </select>
        </label>
        <label className="row check">
          <input type="checkbox" checked={d.scoring} onChange={(e) => void setDefaults({ scoring: e.target.checked })} />
          <span>Scoring (guess the majority)</span>
        </label>
        <label className="row check">
          <input type="checkbox" checked={d.streaks} onChange={(e) => void setDefaults({ streaks: e.target.checked })} />
          <span>Streaks</span>
        </label>
        <label className="row">
          <span>A tie for first (with scoring)</span>
          <select value={d.ties} onChange={(e) => void setDefaults({ ties: e.target.value as RoomSettings["ties"] })}>
            <option value="share">Everyone tied wins</option>
            <option value="one">One winner (longest streak, then fastest votes)</option>
          </select>
        </label>
        <fieldset className="packs">
          <legend>Packs</legend>
          {data.packs.map((p) => (
            <label key={p.id} className="row check">
              <input
                type="checkbox"
                checked={d.packIds.includes(p.id)}
                onChange={(e) => void setDefaults({ packIds: e.target.checked ? [...d.packIds, p.id] : d.packIds.filter((x) => x !== p.id) })}
              />
              <span>
                {p.name} <small className="muted">({p.count})</small>
              </span>
            </label>
          ))}
        </fieldset>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/settings", token, { method: "PUT", body: { roomIdleMinutes: Number(idle) } });
              return "Saved.";
            });
          }}
        >
          <span>Close rooms idle for</span>
          <input className="num" inputMode="numeric" maxLength={5} value={idle} onChange={(e) => setIdle(e.target.value.replace(/D/g, ""))} aria-label="Minutes" /> minutes
          <button className="btn btn-ghost">Save</button>
        </form>
      </section>

      <PacksPanel data={data} token={token} run={run} />
      <MediaPanel data={data} token={token} run={run} />

      <button className="btn btn-ghost" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}

type Run = (fn: () => Promise<string | void>) => Promise<void>;

function PacksPanel({ data, token, run }: { data: AdminOverview; token: string; run: Run }) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const upload = (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    void run(async () => {
      const text = await file.text();
      const r = await api<{ pack: { name: string; count: number }; warnings: string[] }>("/upload/pack", token, { raw: text, query: { name, file: file.name } });
      setWarnings(r.warnings);
      setName("");
      setFile(null);
      return `Added "${r.pack.name}" with ${r.pack.count} questions.`;
    });
  };
  return (
    <section className="panel">
      <h2>Question packs</h2>
      <ul className="pack-list">
        {data.packs.map((p) => (
          <li key={p.id}>
            <span>
              {p.name} <small className="muted">({p.count} questions)</small>
            </span>
            {p.builtIn ? (
              <small className="muted">built in</small>
            ) : (
              <button className="link-btn" onClick={() => window.confirm(`Delete "${p.name}"?`) && void run(async () => void (await api(`/packs/${p.id}`, token, { method: "DELETE" })))}>
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      <form className="upload" onSubmit={upload}>
        <h3>Upload a pack (CSV or JSON)</h3>
        <input maxLength={40} value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} placeholder="Pack name (optional)" />
        <input type="file" accept=".csv,.json,.txt,.tsv,text/csv,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button className="btn btn-secondary" disabled={!file}>
          Upload
        </button>
      </form>
      {warnings.length > 0 && (
        <details open>
          <summary className="muted small">{warnings.length} notes from the upload</summary>
          <ul className="small">
            {warnings.slice(0, 30).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <details>
        <summary className="muted small">File format</summary>
        <div className="small format-help">
          <p>
            <strong>CSV:</strong> a header row with <code>this,that</code> and optionally <code>prompt,this_image,that_image</code>. Without a header the columns are this, that, this image, that image.
          </p>
          <pre>{`this,that,prompt,this_image,that_image
Beach,Mountains,,beach.jpg,mountains.jpg
Tea,Kava,Tonight:,,`}</pre>
          <p>
            <strong>JSON:</strong> a list, or <code>{`{ "name": "…", "questions": [...] }`}</code>:
          </p>
          <pre>{`[{ "this": "Beach", "that": "Mountains", "thisImage": "beach.jpg" },
 { "this": "Tea", "that": "Kava", "prompt": "Tonight:" }]`}</pre>
          <p>Pictures: the name of a picture uploaded below, or an https:// address.</p>
        </div>
      </details>
    </section>
  );
}

function MediaPanel({ data, token, run }: { data: AdminOverview; token: string; run: Run }) {
  const [files, setFiles] = useState<File[]>([]);
  const upload = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const names: string[] = [];
      for (const f of files) {
        const r = await api<{ media: { name: string } }>("/upload/media", token, { raw: f, query: { file: f.name } });
        names.push(r.media.name);
      }
      setFiles([]);
      return `Uploaded: ${names.join(", ")}`;
    });
  };
  return (
    <section className="panel">
      <h2>Pictures</h2>
      <p className="muted small">Upload pictures first, then use their names in a pack's image columns.</p>
      <form className="upload" onSubmit={upload}>
        <input type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        <button className="btn btn-secondary" disabled={!files.length}>
          Upload {files.length > 1 ? `${files.length} pictures` : ""}
        </button>
      </form>
      {data.media.length > 0 && (
        <ul className="media-list">
          {data.media.map((m) => (
            <li key={m.name}>
              <img src={mediaUrl(m.path)} alt="" loading="lazy" />
              <code>{m.name}</code>
              <button className="link-btn small" onClick={() => window.confirm(`Delete ${m.name}?`) && void run(async () => void (await api(`/media/${m.name}`, token, { method: "DELETE" })))}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
