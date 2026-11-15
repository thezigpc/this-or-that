import { createSettingStore } from "@bargames/gamekit/server";
import { ADMIN_SETTINGS_LIMITS, DEFAULT_SETTINGS, SAMPLE_PACK_ID, sanitizeSettings, type AdminSettings, type RoomSettings } from "@thisorthat/shared";
import { DEFAULT_ROOM_IDLE_MINUTES, store } from "../config.js";
import { hasPack } from "../content.js";

// Admin settings in DATA_DIR/settings.json (the kit's setting store: atomic writes; a
// damaged file is left untouched while the defaults apply).
const settings = createSettingStore<AdminSettings>({
  store,
  file: "settings.json",
  defaults: { roomIdleMinutes: DEFAULT_ROOM_IDLE_MINUTES, roomDefaults: { ...DEFAULT_SETTINGS } },
  normalize: clean,
});

export const initAdminSettings = () => settings.init();
export const getAdminSettings = (): AdminSettings => settings.get();

/** Settings a new room starts with: the admin's defaults, packs that still exist. */
export function roomDefaults(): RoomSettings {
  const d = getAdminSettings().roomDefaults;
  const packIds = d.packIds.filter(hasPack);
  return { ...d, packIds: packIds.length ? packIds : [SAMPLE_PACK_ID] };
}

export async function updateAdminSettings(patch: Partial<AdminSettings>): Promise<AdminSettings> {
  return settings.set(validate(patch));
}

const idleOk = (n: number) =>
  Number.isFinite(n) && n >= ADMIN_SETTINGS_LIMITS.roomIdleMinutes.min && n <= ADMIN_SETTINGS_LIMITS.roomIdleMinutes.max;

/** A loaded or merged file, cleaned: unknown keys dropped, bad values back to defaults. */
function clean(s: AdminSettings): AdminSettings {
  const n = Math.round(Number(s.roomIdleMinutes));
  return {
    roomIdleMinutes: idleOk(n) ? n : DEFAULT_ROOM_IDLE_MINUTES,
    roomDefaults: { ...DEFAULT_SETTINGS, ...sanitizeSettings(s.roomDefaults) },
  };
}

function validate(patch: Partial<AdminSettings>): Partial<AdminSettings> {
  const out: Partial<AdminSettings> = {};
  if (patch.roomIdleMinutes !== undefined) {
    const { min, max } = ADMIN_SETTINGS_LIMITS.roomIdleMinutes;
    const n = Math.round(Number(patch.roomIdleMinutes));
    if (!idleOk(n)) throw new Error(`Idle time must be between ${min} and ${max} minutes.`);
    out.roomIdleMinutes = n;
  }
  if (patch.roomDefaults !== undefined) {
    out.roomDefaults = { ...getAdminSettings().roomDefaults, ...sanitizeSettings(patch.roomDefaults, hasPack) };
  }
  return out;
}
