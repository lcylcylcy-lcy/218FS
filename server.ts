import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

type LeaderboardMode = 'timed' | 'survival';

interface SaveSummary {
  coins: number;
  milkMice: number;
  clearedCount: number;
  heroCount: number;
}

interface StoredProfile {
  profileId: string;
  nickname: string;
  nicknameKey: string;
  ownerSecretHash: string;
  saveData: Record<string, unknown>;
  summary: SaveSummary;
  createdAt: number;
  updatedAt: number;
}

interface StoredLeaderboardEntry {
  id: string;
  profileId: string;
  ownerSecretHash: string;
  nickname: string;
  mode: LeaderboardMode;
  heroId: string;
  heroName: string;
  kills: number;
  survivalSec: number;
  score: number;
  updatedAt: number;
}

interface LocalStore {
  profiles: Record<string, StoredProfile>;
  leaderboard: Record<string, StoredLeaderboardEntry>;
}

const PORT = Number(process.env.PORT) || 3000;
const STORE_PATH = path.resolve(process.cwd(), '218fs-store.json');

const DEFAULT_GOOGLE_SHEET_WEBHOOK_URL =
  'https://script.google.com/macros/s/AKfycbxrE9hPJUoKkbqx5YMEPb83AmlXcajlHamkT4AA2Jgt-QKN0tWmL73QGUT0U_bcN18U/exec';

function getWebhookUrl(): string {
  const raw = String(process.env.GOOGLE_SHEET_WEBHOOK_URL || DEFAULT_GOOGLE_SHEET_WEBHOOK_URL || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '169.254.169.254' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

function normNick(raw: unknown): string {
  return String(raw || '')
    .replace(/[\r\n\t<>]/g, '')
    .trim()
    .slice(0, 16);
}

function normId(raw: unknown): string {
  return String(raw || '')
    .replace(/[^\w\-.:]/g, '')
    .trim()
    .slice(0, 80);
}

function hashSecret(secret: unknown): string {
  const raw = String(secret || '').trim();
  if (!raw) return '';
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function stripSaveSecrets(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const clone = { ...(raw as Record<string, unknown>) };
  delete clone.profileSecret;
  delete clone.ownerSecret;
  delete clone.ownerSecretHash;
  return clone;
}

function buildSummary(saveData: Record<string, unknown>): SaveSummary {
  return {
    coins: Math.max(0, Number(saveData.coins) || 0),
    milkMice: Math.max(0, Number(saveData.milkMice) || 0),
    clearedCount: Array.isArray(saveData.clearedStages) ? saveData.clearedStages.length : 0,
    heroCount: Array.isArray(saveData.unlockedHeroes) ? saveData.unlockedHeroes.length : 0,
  };
}

function readLocalStore(): LocalStore {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return { profiles: {}, leaderboard: {} };
    }
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LocalStore>;
    return {
      profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
      leaderboard: parsed.leaderboard && typeof parsed.leaderboard === 'object' ? parsed.leaderboard : {},
    };
  } catch {
    return { profiles: {}, leaderboard: {} };
  }
}

function writeLocalStore(store: LocalStore): void {
  const tmpPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmpPath, STORE_PATH);
}

function isBetterScore(
  nextKills: number,
  nextSec: number,
  prevKills: number,
  prevSec: number,
  mode: LeaderboardMode
): boolean {
  if (mode === 'timed') {
    if (nextKills !== prevKills) return nextKills > prevKills;
    return nextSec > prevSec;
  }
  if (nextSec !== prevSec) return nextSec > prevSec;
  return nextKills > prevKills;
}

function sortLeaderboardEntries(
  entries: StoredLeaderboardEntry[],
  mode: LeaderboardMode
): StoredLeaderboardEntry[] {
  return [...entries].sort((a, b) => {
    if (mode === 'timed') {
      if (b.kills !== a.kills) return b.kills - a.kills;
      if (b.survivalSec !== a.survivalSec) return b.survivalSec - a.survivalSec;
      return a.updatedAt - b.updatedAt;
    }
    if (b.survivalSec !== a.survivalSec) return b.survivalSec - a.survivalSec;
    if (b.kills !== a.kills) return b.kills - a.kills;
    return a.updatedAt - b.updatedAt;
  });
}

function computeLocalChampions(store: LocalStore) {
  const all = Object.values(store.leaderboard);
  const timedTop = sortLeaderboardEntries(
    all.filter((e) => e.mode === 'timed'),
    'timed'
  )[0];
  const survivalTop = sortLeaderboardEntries(
    all.filter((e) => e.mode === 'survival'),
    'survival'
  )[0];

  return {
    timedProfileId: timedTop ? String(timedTop.profileId || '') : '',
    timedNickname: timedTop ? String(timedTop.nickname || '') : '',
    survivalProfileId: survivalTop ? String(survivalTop.profileId || '') : '',
    survivalNickname: survivalTop ? String(survivalTop.nickname || '') : '',
  };
}

function handleLocalAction(action: string, payload: Record<string, unknown>): Record<string, unknown> {
  const store = readLocalStore();

  if (action === 'getChampions') {
    return { ok: true, ...computeLocalChampions(store) };
  }

  if (action === 'listSlots') {
    return { ok: true, slots: [] };
  }

  if (action === 'lookupProfile') {
    const nickname = normNick(payload.nickname);
    const key = nickname.toLowerCase();
    const secretHash = String(payload.ownerSecretHash || '').trim();
    if (!nickname || !secretHash) {
      return { ok: false, error: '請同時輸入暱稱與引繼碼才能載入雲端存檔。' };
    }
    const match = Object.values(store.profiles).find(
      (p) => String(p.nicknameKey || '').toLowerCase() === key
    );
    if (!match || !match.ownerSecretHash || !constantTimeEqual(match.ownerSecretHash, secretHash)) {
      return { ok: false, error: '暱稱不存在或引繼碼錯誤，無法載入該雲端存檔。' };
    }
    return {
      ok: true,
      verifiedByCloud: true,
      profile: {
        profileId: match.profileId,
        nickname: match.nickname,
        saveData: stripSaveSecrets(match.saveData),
        summary: match.summary || buildSummary(match.saveData || {}),
        updatedAt: Number(match.updatedAt) || 0,
      },
    };
  }

  if (action === 'bindProfile' || action === 'saveProfile') {
    const profileId = normId(payload.profileId);
    const nickname = normNick(payload.nickname);
    const key = nickname.toLowerCase();
    const secretHash = String(payload.ownerSecretHash || '').trim();
    const saveData = stripSaveSecrets(payload.saveData);

    if (!profileId || !nickname || !secretHash) {
      return { ok: false, error: '缺少存檔識別碼、暱稱或引繼碼' };
    }

    const conflict = Object.values(store.profiles).find(
      (p) => String(p.nicknameKey || '').toLowerCase() === key && p.profileId !== profileId
    );
    if (conflict) {
      return {
        ok: false,
        conflict: true,
        error: `暱稱「${conflict.nickname}」已被其他玩家使用，請改用別的暱稱；若是你自己的帳號，請用「暱稱＋引繼碼」驗證載入。`,
      };
    }

    const existing = store.profiles[profileId];
    if (existing && existing.ownerSecretHash && !constantTimeEqual(existing.ownerSecretHash, secretHash)) {
      return { ok: false, error: '存檔引繼碼驗證不符，無法覆寫此存檔空間。' };
    }

    const now = Date.now();
    const summary = buildSummary(saveData);
    const prevNickname = existing ? existing.nickname : '';

    store.profiles[profileId] = {
      profileId,
      nickname,
      nicknameKey: key,
      ownerSecretHash: (existing && existing.ownerSecretHash) || secretHash,
      saveData,
      summary,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    Object.values(store.leaderboard).forEach((row) => {
      if (row.profileId === profileId && row.nickname !== nickname) {
        row.nickname = nickname;
        row.updatedAt = now;
      }
    });

    writeLocalStore(store);

    return {
      ok: true,
      renamedFrom: prevNickname && prevNickname !== nickname ? prevNickname : '',
      profile: {
        profileId,
        nickname,
        updatedAt: now,
        summary,
      },
    };
  }

  if (action === 'listLeaderboard') {
    const mode: LeaderboardMode = payload.mode === 'survival' ? 'survival' : 'timed';
    const entries = sortLeaderboardEntries(
      Object.values(store.leaderboard).filter((r) => r.mode === mode),
      mode
    )
      .slice(0, 100)
      .map((r) => ({
        id: r.id,
        profileId: r.profileId,
        nickname: r.nickname || '無名勇者',
        mode: r.mode,
        heroId: r.heroId || '',
        heroName: r.heroName || '夥伴',
        kills: Number(r.kills) || 0,
        survivalSec: Number(r.survivalSec) || 0,
        score: Number(r.score) || 0,
        updatedAt: Number(r.updatedAt) || 0,
      }));

    return {
      ok: true,
      entries,
      champions: computeLocalChampions(store),
    };
  }

  if (action === 'submitScore') {
    const profileId = normId(payload.profileId);
    const nickname = normNick(payload.nickname);
    const key = nickname.toLowerCase();
    const mode: LeaderboardMode = payload.mode === 'survival' ? 'survival' : 'timed';
    const secretHash = String(payload.ownerSecretHash || '').trim();
    const kills = Math.max(0, Math.floor(Number(payload.kills) || 0));
    const survivalSec = Math.max(0, Number(payload.survivalSec) || 0);
    const score = Number(payload.score) || 0;
    const heroId = String(payload.heroId || 'pudding').slice(0, 40);
    const heroName = String(payload.heroName || '夥伴').slice(0, 32);

    if (heroId === 'bigYan') {
      return { ok: false, error: '大皮炎為專屬特別角色，不能拿來打排位賽喔！' };
    }
    if (!profileId || !nickname || !secretHash) {
      return { ok: false, error: '缺少必要資料或存檔引繼碼' };
    }

    const conflict = Object.values(store.profiles).find(
      (p) => String(p.nicknameKey || '').toLowerCase() === key && p.profileId !== profileId
    );
    if (conflict) {
      return {
        ok: false,
        conflict: true,
        error: `暱稱「${conflict.nickname}」已綁定其他存檔空間，請更換暱稱；若是你自己的帳號，請用「暱稱＋引繼碼」驗證載入。`,
      };
    }

    const existingProfile = store.profiles[profileId];
    if (
      existingProfile &&
      existingProfile.ownerSecretHash &&
      !constantTimeEqual(existingProfile.ownerSecretHash, secretHash)
    ) {
      return { ok: false, error: '存檔引繼碼驗證不符，無法提交此存檔成績。' };
    }

    const entryId = `${profileId}__${mode}`;
    const existingEntry = store.leaderboard[entryId];
    if (
      existingEntry &&
      existingEntry.ownerSecretHash &&
      !constantTimeEqual(existingEntry.ownerSecretHash, secretHash)
    ) {
      return { ok: false, error: '存檔引繼碼驗證不符，無法更新此榜位紀錄。' };
    }

    const now = Date.now();
    const incomingSave =
      payload.saveData && typeof payload.saveData === 'object'
        ? stripSaveSecrets(payload.saveData)
        : null;

    if (incomingSave || !existingProfile) {
      const mergedSave = incomingSave || { profileId, nickname };
      store.profiles[profileId] = {
        profileId,
        nickname,
        nicknameKey: key,
        ownerSecretHash: (existingProfile && existingProfile.ownerSecretHash) || secretHash,
        saveData: mergedSave,
        summary: buildSummary(mergedSave),
        createdAt: existingProfile?.createdAt || now,
        updatedAt: now,
      };
    }

    Object.values(store.leaderboard).forEach((row) => {
      if (row.profileId === profileId && row.nickname !== nickname) {
        row.nickname = nickname;
        row.updatedAt = now;
      }
    });

    let improved = true;

    if (existingEntry) {
      if (isBetterScore(kills, survivalSec, existingEntry.kills, existingEntry.survivalSec, mode)) {
        store.leaderboard[entryId] = {
          id: entryId,
          profileId,
          ownerSecretHash: existingEntry.ownerSecretHash || secretHash,
          nickname,
          mode,
          heroId,
          heroName,
          kills,
          survivalSec,
          score,
          updatedAt: now,
        };
      } else {
        improved = false;
        existingEntry.nickname = nickname;
        existingEntry.updatedAt = now;
      }
    } else {
      store.leaderboard[entryId] = {
        id: entryId,
        profileId,
        ownerSecretHash: secretHash,
        nickname,
        mode,
        heroId,
        heroName,
        kills,
        survivalSec,
        score,
        updatedAt: now,
      };
    }

    writeLocalStore(store);

    const sortedAfter = sortLeaderboardEntries(
      Object.values(store.leaderboard).filter((r) => r.mode === mode),
      mode
    );
    const rank = sortedAfter.findIndex((r) => r.id === entryId) + 1;

    return {
      ok: true,
      entryId,
      rank: rank > 0 ? rank : 1,
      updatedExisting: Boolean(existingEntry),
      improved,
      champions: computeLocalChampions(store),
    };
  }

  if (action === 'deleteScore') {
    const entryId = normId(payload.entryId);
    const profileId = normId(payload.profileId);
    const secretHash = String(payload.ownerSecretHash || '').trim();
    const existing = store.leaderboard[entryId];
    if (!existing) {
      return { ok: false, error: '找不到這筆排位紀錄' };
    }
    if (
      existing.profileId !== profileId ||
      !secretHash ||
      (existing.ownerSecretHash && !constantTimeEqual(existing.ownerSecretHash, secretHash))
    ) {
      return { ok: false, error: '只能刪除自己的排位成績，不能刪除別人的！' };
    }
    delete store.leaderboard[entryId];
    writeLocalStore(store);
    return { ok: true, champions: computeLocalChampions(store) };
  }

  return { ok: false, error: 'Unknown action' };
}

const CACHE_FRESH_MS = 12_000;
const CACHE_STALE_MS = 180_000;
const WEBHOOK_READ_TIMEOUT_MS = 6_500;
const WEBHOOK_WRITE_TIMEOUT_MS = 9_000;

interface CachedLeaderboard {
  entries: Array<Record<string, unknown>>;
  champions: Record<string, unknown>;
  fetchedAt: number;
}

const leaderboardCache: Record<LeaderboardMode, CachedLeaderboard | null> = {
  timed: null,
  survival: null,
};
let championsCache: { data: Record<string, unknown>; fetchedAt: number } | null = null;
const inflightCloud = new Map<string, Promise<Record<string, unknown>>>();

function sortGenericEntries(
  entries: Array<Record<string, unknown>>,
  mode: LeaderboardMode
): Array<Record<string, unknown>> {
  return [...entries].sort((a, b) => {
    const aKills = Number(a.kills) || 0;
    const bKills = Number(b.kills) || 0;
    const aSec = Number(a.survivalSec) || 0;
    const bSec = Number(b.survivalSec) || 0;
    const aTime = Number(a.updatedAt) || 0;
    const bTime = Number(b.updatedAt) || 0;
    if (mode === 'timed') {
      if (bKills !== aKills) return bKills - aKills;
      if (bSec !== aSec) return bSec - aSec;
      return aTime - bTime;
    }
    if (bSec !== aSec) return bSec - aSec;
    if (bKills !== aKills) return bKills - aKills;
    return aTime - bTime;
  });
}

function deriveChampionsFromCaches(): Record<string, unknown> | null {
  const timedTop = leaderboardCache.timed?.entries?.[0];
  const survivalTop = leaderboardCache.survival?.entries?.[0];
  if (!leaderboardCache.timed && !leaderboardCache.survival) return null;
  return {
    ok: true,
    timedProfileId: timedTop ? String(timedTop.profileId || '') : String(championsCache?.data?.timedProfileId || ''),
    timedNickname: timedTop ? String(timedTop.nickname || '') : String(championsCache?.data?.timedNickname || ''),
    survivalProfileId: survivalTop ? String(survivalTop.profileId || '') : String(championsCache?.data?.survivalProfileId || ''),
    survivalNickname: survivalTop ? String(survivalTop.nickname || '') : String(championsCache?.data?.survivalNickname || ''),
  };
}

function updateChampionsCache(champions: Record<string, unknown> | undefined) {
  if (!champions || typeof champions !== 'object') return;
  championsCache = {
    data: {
      ok: true,
      timedProfileId: String(champions.timedProfileId || ''),
      timedNickname: String(champions.timedNickname || ''),
      survivalProfileId: String(champions.survivalProfileId || ''),
      survivalNickname: String(champions.survivalNickname || ''),
    },
    fetchedAt: Date.now(),
  };
}

function applyOptimisticSubmitToCache(
  mode: LeaderboardMode,
  entry: Record<string, unknown>,
  serverEntries?: Array<Record<string, unknown>>,
  serverChampions?: Record<string, unknown>
): Array<Record<string, unknown>> {
  const now = Date.now();
  let nextEntries: Array<Record<string, unknown>>;

  if (Array.isArray(serverEntries)) {
    nextEntries = sortGenericEntries(serverEntries, mode).slice(0, 100);
  } else {
    const prevList = leaderboardCache[mode]?.entries ? [...leaderboardCache[mode]!.entries] : [];
    const entryId = String(entry.id || `${entry.profileId}__${mode}`);
    const profileId = String(entry.profileId || '');
    const nickname = String(entry.nickname || '無名勇者');
    const nextKills = Number(entry.kills) || 0;
    const nextSec = Number(entry.survivalSec) || 0;

    let found = false;
    const updated = prevList.map((row) => {
      const sameProfile = profileId && String(row.profileId || '') === profileId;
      if (String(row.id || '') === entryId || sameProfile) {
        found = true;
        const prevKills = Number(row.kills) || 0;
        const prevSec = Number(row.survivalSec) || 0;
        if (isBetterScore(nextKills, nextSec, prevKills, prevSec, mode)) {
          return { ...row, ...entry, id: entryId, nickname, updatedAt: now };
        }
        return { ...row, nickname, updatedAt: now };
      }
      return row;
    });
    if (!found) {
      updated.push({ ...entry, id: entryId, updatedAt: now });
    }
    nextEntries = sortGenericEntries(updated, mode).slice(0, 100);
  }

  // Also sync nickname across the other mode's cache if present
  const otherMode: LeaderboardMode = mode === 'timed' ? 'survival' : 'timed';
  if (leaderboardCache[otherMode]) {
    leaderboardCache[otherMode]!.entries = leaderboardCache[otherMode]!.entries.map((row) =>
      String(row.profileId || '') === String(entry.profileId || '')
        ? { ...row, nickname: String(entry.nickname || row.nickname || '') }
        : row
    );
  }

  if (serverChampions) {
    updateChampionsCache(serverChampions);
  } else {
    const derived = deriveChampionsFromCaches();
    if (derived) updateChampionsCache(derived);
  }

  leaderboardCache[mode] = {
    entries: nextEntries,
    champions: championsCache?.data || serverChampions || {},
    fetchedAt: now,
  };
  return nextEntries;
}

function applyDeleteToCache(
  entryId: string,
  serverChampions?: Record<string, unknown>
): LeaderboardMode | null {
  let touchedMode: LeaderboardMode | null = null;
  (['timed', 'survival'] as LeaderboardMode[]).forEach((m) => {
    const cached = leaderboardCache[m];
    if (!cached) return;
    const before = cached.entries.length;
    cached.entries = cached.entries.filter((r) => String(r.id || '') !== entryId);
    if (cached.entries.length !== before) {
      touchedMode = m;
      cached.fetchedAt = Date.now();
    }
  });
  if (serverChampions) {
    updateChampionsCache(serverChampions);
  }
  return touchedMode;
}

const WRITE_ACTIONS = new Set(['submitScore', 'deleteScore', 'bindProfile', 'saveProfile']);

async function dispatchCloudAction(
  action: string,
  payload: Record<string, unknown> = {},
  dedupeKey?: string
): Promise<Record<string, unknown>> {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) {
    return handleLocalAction(action, payload);
  }

  if (dedupeKey && inflightCloud.has(dedupeKey)) {
    return inflightCloud.get(dedupeKey)!;
  }

  const timeoutMs = WRITE_ACTIONS.has(action) ? WEBHOOK_WRITE_TIMEOUT_MS : WEBHOOK_READ_TIMEOUT_MS;

  const run = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
        redirect: 'follow',
        signal: controller.signal,
      });

      const text = await resp.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (!resp.ok || typeof parsed !== 'object' || parsed === null) {
        throw new Error(`Webhook HTTP ${resp.status}`);
      }
      return parsed;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[Cloud218] Webhook fallback for "${action}" (${errMsg})`);
      return { ...handleLocalAction(action, payload), _localFallback: true };
    } finally {
      clearTimeout(timer);
      if (dedupeKey) inflightCloud.delete(dedupeKey);
    }
  })();

  if (dedupeKey) {
    inflightCloud.set(dedupeKey, run);
  }
  return run;
}

async function refreshLeaderboardFromCloud(mode: LeaderboardMode): Promise<CachedLeaderboard> {
  const prev = leaderboardCache[mode];
  const result = await dispatchCloudAction('listLeaderboard', { mode }, `listLeaderboard:${mode}`);
  if (result._localFallback && prev && prev.entries.length > 0) {
    return prev;
  }
  const entries = Array.isArray(result.entries)
    ? sortGenericEntries(result.entries as Array<Record<string, unknown>>, mode).slice(0, 100)
    : [];
  const champions =
    result.champions && typeof result.champions === 'object'
      ? (result.champions as Record<string, unknown>)
      : deriveChampionsFromCaches() || {};
  if (result.champions && typeof result.champions === 'object') {
    updateChampionsCache(champions);
  }
  const snapshot: CachedLeaderboard = {
    entries,
    champions,
    fetchedAt: Date.now(),
  };
  leaderboardCache[mode] = snapshot;
  return snapshot;
}

async function refreshChampionsFromCloud(): Promise<Record<string, unknown>> {
  const result = await dispatchCloudAction('getChampions', {}, 'getChampions');
  if (result.ok && (!result._localFallback || !championsCache)) {
    updateChampionsCache(result);
  } else if (result._localFallback && championsCache) {
    return championsCache.data;
  }
  return result;
}

function formatEntriesForProfile(
  entries: Array<Record<string, unknown>>,
  profileId: string
): Array<Record<string, unknown>> {
  return entries.map((entry) => ({
    ...entry,
    isMine: Boolean(profileId && String(entry.profileId || '') === profileId),
  }));
}

async function warmUpCaches() {
  if (!getWebhookUrl()) return;
  try {
    // Stagger startup calls sequentially so Google Apps Script doesn't queue concurrent locks on cold start
    await refreshLeaderboardFromCloud('timed');
    await refreshLeaderboardFromCloud('survival');
  } catch {
    // Non-fatal startup warm-up
  }
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      storage: getWebhookUrl() ? 'google_sheet' : 'local_store',
    });
  });

  app.get('/api/profile/slots', (_req, res) => {
    // Public enumeration of other players' accounts is disabled for account security
    return res.json({ ok: true, slots: [] });
  });

  app.post('/api/profile/lookup', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const nickname = normNick(body.nickname);
    const ownerSecretHash = hashSecret(body.ownerSecret);
    if (!nickname || !ownerSecretHash) {
      return res.status(400).json({ ok: false, error: '請同時輸入暱稱與引繼碼才能載入雲端存檔。' });
    }
    const result = await dispatchCloudAction('lookupProfile', { nickname, ownerSecretHash });
    if (!result.ok) {
      return res.json({ ok: false, error: String(result.error || '暱稱不存在或引繼碼錯誤，無法載入該雲端存檔。') });
    }
    const cloudProfile = result.profile && typeof result.profile === 'object' ? (result.profile as Record<string, unknown>) : null;
    if (!result.verifiedByCloud) {
      // Defense-in-depth if external webhook still runs legacy Code.gs without server-side hash check
      const localMatch = cloudProfile?.profileId ? readLocalStore().profiles[String(cloudProfile.profileId)] : undefined;
      if (!localMatch?.ownerSecretHash || !constantTimeEqual(localMatch.ownerSecretHash, ownerSecretHash)) {
        return res.json({ ok: false, error: '雲端尚未啟用引繼碼驗證或引繼碼錯誤，請先更新部署 Code.gs。' });
      }
    }
    return res.json({
      ok: true,
      profile: cloudProfile
        ? {
            profileId: String(cloudProfile.profileId || ''),
            nickname: String(cloudProfile.nickname || nickname),
            saveData: stripSaveSecrets(cloudProfile.saveData),
            summary: cloudProfile.summary,
            updatedAt: Number(cloudProfile.updatedAt) || 0,
          }
        : undefined,
    });
  });

  app.post('/api/profile/bind', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const profileId = normId(body.profileId);
    const nickname = normNick(body.nickname);
    const ownerSecretHash = hashSecret(body.ownerSecret);
    if (!profileId || !nickname || !ownerSecretHash) {
      return res.status(400).json({ ok: false, error: '缺少存檔識別碼、暱稱或引繼碼' });
    }
    const localExisting = readLocalStore().profiles[profileId];
    if (localExisting?.ownerSecretHash && !constantTimeEqual(localExisting.ownerSecretHash, ownerSecretHash)) {
      return res.status(403).json({ ok: false, error: '存檔引繼碼驗證不符，無法覆寫此存檔空間。' });
    }
    const result = await dispatchCloudAction('bindProfile', {
      profileId,
      nickname,
      ownerSecretHash,
      saveData: stripSaveSecrets(body.saveData),
    });
    if (result.ok) {
      (['timed', 'survival'] as LeaderboardMode[]).forEach((m) => {
        if (leaderboardCache[m]) {
          leaderboardCache[m]!.entries = leaderboardCache[m]!.entries.map((row) =>
            String(row.profileId || '') === profileId ? { ...row, nickname } : row
          );
        }
      });
      return res.json(result);
    }
    const safeResult = { ...result };
    delete safeResult.existingProfile;
    return res.json(safeResult);
  });

  app.post('/api/profile/save', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const profileId = normId(body.profileId);
    const nickname = normNick(body.nickname);
    const ownerSecretHash = hashSecret(body.ownerSecret);
    if (!profileId || !nickname || !ownerSecretHash) {
      return res.status(400).json({ ok: false, error: '缺少存檔識別碼、暱稱或引繼碼' });
    }
    const localExisting = readLocalStore().profiles[profileId];
    if (localExisting?.ownerSecretHash && !constantTimeEqual(localExisting.ownerSecretHash, ownerSecretHash)) {
      return res.status(403).json({ ok: false, error: '存檔引繼碼驗證不符，無法覆寫此存檔空間。' });
    }
    const result = await dispatchCloudAction('saveProfile', {
      profileId,
      nickname,
      ownerSecretHash,
      saveData: stripSaveSecrets(body.saveData),
    });
    const safeResult = { ...result };
    delete safeResult.existingProfile;
    return res.json(safeResult);
  });

  app.get('/api/leaderboard/champions', async (req, res) => {
    const profileId = normId(req.query.profileId);
    const force = req.query.force === '1';
    const now = Date.now();
    let result: Record<string, unknown>;
    if (!force && championsCache && now - championsCache.fetchedAt < CACHE_STALE_MS) {
      result = championsCache.data;
      if (now - championsCache.fetchedAt > CACHE_FRESH_MS) {
        void refreshChampionsFromCloud();
      }
    } else {
      result = await refreshChampionsFromCloud();
    }
    const timedProfileId = String(result.timedProfileId || '');
    const survivalProfileId = String(result.survivalProfileId || '');
    res.json({
      ...result,
      timedRank1: Boolean(profileId && timedProfileId === profileId),
      survivalRank1: Boolean(profileId && survivalProfileId === profileId),
    });
  });

  app.get('/api/leaderboard', async (req, res) => {
    const mode: LeaderboardMode = req.query.mode === 'survival' ? 'survival' : 'timed';
    const profileId = normId(req.query.profileId);
    const force = req.query.force === '1';
    const now = Date.now();
    const cached = leaderboardCache[mode];

    if (!force && cached && now - cached.fetchedAt < CACHE_STALE_MS) {
      if (now - cached.fetchedAt > CACHE_FRESH_MS) {
        void refreshLeaderboardFromCloud(mode);
      }
      return res.json({
        ok: true,
        entries: formatEntriesForProfile(cached.entries, profileId),
        champions: championsCache?.data || cached.champions,
        cached: true,
      });
    }

    const fresh = await refreshLeaderboardFromCloud(mode);
    return res.json({
      ok: true,
      entries: formatEntriesForProfile(fresh.entries, profileId),
      champions: fresh.champions,
    });
  });

  app.post('/api/leaderboard/submit', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const profileId = normId(body.profileId);
    const nickname = normNick(body.nickname);
    const mode: LeaderboardMode = body.mode === 'survival' ? 'survival' : 'timed';
    const heroId = String(body.heroId || 'pudding').slice(0, 40);
    const heroName = String(body.heroName || '夥伴').slice(0, 32);
    const kills = Math.max(0, Math.floor(Number(body.kills) || 0));
    const survivalSec = Math.max(0, Number(body.survivalSec) || 0);
    const score = Number(body.score) || 0;

    const ownerSecretHash = hashSecret(body.ownerSecret);
    if (!profileId || !nickname || !ownerSecretHash) {
      return res.status(400).json({ ok: false, error: '缺少必要資料或存檔引繼碼' });
    }

    const result = await dispatchCloudAction('submitScore', {
      profileId,
      nickname,
      ownerSecretHash,
      mode,
      heroId,
      heroName,
      kills,
      survivalSec,
      score,
      saveData: body.saveData && typeof body.saveData === 'object' ? stripSaveSecrets(body.saveData) : null,
    });

    if (result.ok) {
      const serverEntries = Array.isArray(result.entries)
        ? (result.entries as Array<Record<string, unknown>>)
        : undefined;
      const serverChampions =
        result.champions && typeof result.champions === 'object'
          ? (result.champions as Record<string, unknown>)
          : undefined;

      const updatedEntries = applyOptimisticSubmitToCache(
        mode,
        {
          id: String(result.entryId || `${profileId}__${mode}`),
          profileId,
          nickname,
          mode,
          heroId,
          heroName,
          kills,
          survivalSec,
          score,
          updatedAt: Date.now(),
        },
        serverEntries,
        serverChampions
      );

      if (!serverEntries) {
        void refreshLeaderboardFromCloud(mode);
      }

      return res.json({
        ...result,
        entries: formatEntriesForProfile(updatedEntries, profileId),
        champions: serverChampions || championsCache?.data,
      });
    }

    return res.json(result);
  });

  app.post('/api/leaderboard/delete', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const entryId = normId(body.entryId);
    const profileId = normId(body.profileId);
    const result = await dispatchCloudAction('deleteScore', {
      entryId,
      profileId,
      ownerSecretHash: hashSecret(body.ownerSecret),
    });
    if (result.ok) {
      const serverChampions =
        result.champions && typeof result.champions === 'object'
          ? (result.champions as Record<string, unknown>)
          : undefined;
      const touchedMode = applyDeleteToCache(entryId, serverChampions);
      const entries =
        touchedMode && leaderboardCache[touchedMode]
          ? formatEntriesForProfile(leaderboardCache[touchedMode]!.entries, profileId)
          : undefined;
      return res.json({
        ...result,
        entries,
      });
    }
    return res.json(result);
  });

  if (process.env.NODE_ENV !== 'production') {
    if (!process.env.DISABLE_HMR) process.env.DISABLE_HMR = 'true';
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'custom',
    });
    app.use(vite.middlewares);
    app.get('*', async (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      try {
        const rawHtml = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8');
        const transformed = await vite.transformIndexHtml(req.originalUrl, rawHtml);
        const cleanHtml = transformed.replace(/<script\s+type="module"\s+src="\/@vite\/client"><\/script>\s*/i, '');
        res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8' }).end(cleanHtml);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`218 family survivor server listening on http://0.0.0.0:${PORT}`);
    void warmUpCaches();
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
