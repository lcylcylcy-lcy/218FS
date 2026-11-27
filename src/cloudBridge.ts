import { getClientWebhookUrl } from './cloudConfig';

export interface SaveSummary {
  coins: number;
  milkMice: number;
  clearedCount: number;
  heroCount: number;
}

export interface CloudProfile {
  profileId: string;
  nickname: string;
  saveData?: Record<string, unknown>;
  summary?: SaveSummary;
  updatedAt?: number;
}

export interface CloudProfileSlot {
  profileId: string;
  nickname: string;
  updatedAt: number;
  summary: SaveSummary;
}

export interface ChampionsPayload {
  ok: boolean;
  timedProfileId?: string;
  timedNickname?: string;
  survivalProfileId?: string;
  survivalNickname?: string;
  timedRank1?: boolean;
  survivalRank1?: boolean;
  error?: string;
}

export interface LeaderboardEntry {
  id: string;
  profileId: string;
  nickname: string;
  mode: 'timed' | 'survival';
  heroId: string;
  heroName: string;
  kills: number;
  survivalSec: number;
  score: number;
  updatedAt: number;
  isMine?: boolean;
}

export interface SaveProfilePayload {
  profileId: string;
  nickname: string;
  ownerSecret?: string;
  saveData: Record<string, unknown>;
}

export interface SubmitScorePayload {
  profileId: string;
  ownerSecret?: string;
  nickname: string;
  mode: 'timed' | 'survival';
  heroId: string;
  heroName: string;
  kills: number;
  survivalSec: number;
  score?: number;
  saveData?: Record<string, unknown>;
}

export interface DeleteScorePayload {
  entryId: string;
  profileId: string;
  ownerSecret?: string;
}

interface FetchLeaderboardOptions {
  force?: boolean;
}

interface CloudBridgeApi {
  saveProfileSnapshot: (payload: SaveProfilePayload) => Promise<Record<string, unknown>>;
  bindOrRenameNickname: (payload: SaveProfilePayload) => Promise<Record<string, unknown>>;
  lookupProfileByNickname: (
    nickname: string,
    ownerSecret: string
  ) => Promise<{
    ok: boolean;
    profile?: CloudProfile;
    error?: string;
  }>;
  listCloudProfileSlots: () => Promise<CloudProfileSlot[]>;
  fetchLeaderboardChampions: (profileId?: string, options?: FetchLeaderboardOptions) => Promise<ChampionsPayload>;
  fetchLeaderboard: (
    mode: 'timed' | 'survival',
    profileId?: string,
    options?: FetchLeaderboardOptions
  ) => Promise<LeaderboardEntry[]>;
  getCachedLeaderboard: (mode: 'timed' | 'survival', profileId?: string) => LeaderboardEntry[];
  getCachedChampions: (profileId?: string) => ChampionsPayload | null;
  prefetchLeaderboards: (profileId?: string) => Promise<void>;
  submitEndlessScore: (payload: SubmitScorePayload) => Promise<Record<string, unknown>>;
  deleteLeaderboardEntry: (payload: DeleteScorePayload) => Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    Cloud218?: CloudBridgeApi;
    __CLOUD_CONFIG__?: {
      googleSheetWebhookUrl?: string;
    };
  }
}

function isStaticOnlyHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname.toLowerCase();
  return host.endsWith('.github.io') || window.location.protocol === 'file:';
}

let backendMode: 'unknown' | 'api' | 'direct' = isStaticOnlyHost() ? 'direct' : 'unknown';

const LB_CACHE_STORAGE_KEY = '218fs_lb_cache_v1';
const CLIENT_CACHE_FRESH_MS = 15_000;

interface ClientLbCacheBucket {
  entries: LeaderboardEntry[];
  fetchedAt: number;
}

interface ClientLbCacheState {
  timed: ClientLbCacheBucket | null;
  survival: ClientLbCacheBucket | null;
  champions: ChampionsPayload | null;
  championsFetchedAt: number;
}

const memCache: ClientLbCacheState = {
  timed: null,
  survival: null,
  champions: null,
  championsFetchedAt: 0,
};

const inflightMap = new Map<string, Promise<unknown>>();

function loadCacheFromStorage() {
  if (memCache.timed || memCache.survival || memCache.champions) return;
  try {
    const raw = localStorage.getItem(LB_CACHE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<ClientLbCacheState>;
    if (parsed.timed && Array.isArray(parsed.timed.entries)) {
      memCache.timed = parsed.timed;
    }
    if (parsed.survival && Array.isArray(parsed.survival.entries)) {
      memCache.survival = parsed.survival;
    }
    if (parsed.champions && typeof parsed.champions === 'object') {
      memCache.champions = parsed.champions;
      memCache.championsFetchedAt = Number(parsed.championsFetchedAt) || 0;
    }
  } catch {
    // Ignore storage parse error
  }
}

function saveCacheToStorage() {
  try {
    localStorage.setItem(LB_CACHE_STORAGE_KEY, JSON.stringify(memCache));
  } catch {
    // Ignore quota errors
  }
}

function sortEntriesClient(entries: LeaderboardEntry[], mode: 'timed' | 'survival'): LeaderboardEntry[] {
  return [...entries].sort((a, b) => {
    const ak = Number(a.kills) || 0;
    const bk = Number(b.kills) || 0;
    const as = Number(a.survivalSec) || 0;
    const bs = Number(b.survivalSec) || 0;
    if (mode === 'timed') {
      if (bk !== ak) return bk - ak;
      if (bs !== as) return bs - as;
      return (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0);
    }
    if (bs !== as) return bs - as;
    if (bk !== ak) return bk - ak;
    return (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0);
  });
}

function tagEntriesWithMine(entries: LeaderboardEntry[], profileId = ''): LeaderboardEntry[] {
  return entries.map((e) => ({
    ...e,
    isMine: Boolean(profileId && String(e.profileId || '') === profileId),
  }));
}

function cacheLeaderboardResult(
  mode: 'timed' | 'survival',
  entries: LeaderboardEntry[],
  champions?: ChampionsPayload | null
) {
  const cleanEntries = sortEntriesClient(
    entries.map((e) => ({ ...e, isMine: undefined })),
    mode
  ).slice(0, 100);
  memCache[mode] = { entries: cleanEntries, fetchedAt: Date.now() };
  if (champions && typeof champions === 'object') {
    memCache.champions = {
      ok: true,
      timedProfileId: String(champions.timedProfileId || ''),
      timedNickname: String(champions.timedNickname || ''),
      survivalProfileId: String(champions.survivalProfileId || ''),
      survivalNickname: String(champions.survivalNickname || ''),
    };
    memCache.championsFetchedAt = Date.now();
  }
  saveCacheToStorage();
}

function formatChampionsForProfile(
  raw: ChampionsPayload | null,
  profileId = ''
): ChampionsPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const timedProfileId = String(raw.timedProfileId || '');
  const survivalProfileId = String(raw.survivalProfileId || '');
  return {
    ...raw,
    ok: true,
    timedRank1: Boolean(profileId && timedProfileId === profileId),
    survivalRank1: Boolean(profileId && survivalProfileId === profileId),
  };
}

function stripSaveSecrets(raw?: Record<string, unknown> | null): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const clone = { ...raw };
  delete clone.profileSecret;
  delete clone.ownerSecret;
  delete clone.ownerSecretHash;
  return clone;
}

async function hashSecretBrowser(secret?: string): Promise<string> {
  const raw = String(secret || '').trim();
  if (!raw) return '';
  try {
    if (typeof window !== 'undefined' && window.crypto?.subtle) {
      const encoded = new TextEncoder().encode(raw);
      const digest = await window.crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // Fallback below if WebCrypto subtle digest is unavailable in an insecure context
  }
  let h1 = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h1 ^= raw.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return `fnv_${(h1 >>> 0).toString(16)}`;
}

async function tryApiFetch<T = Record<string, unknown>>(
  url: string,
  init: RequestInit
): Promise<{ available: boolean; data?: T; networkError?: boolean }> {
  if (backendMode === 'direct') {
    return { available: false };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { available: false, networkError: true };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 20_000) : null;
    let timedOut = false;
    try {
      const resp = await fetch(url, {
        ...init,
        signal: init.signal || controller?.signal,
      });
      const contentType = String(resp.headers.get('content-type') || '').toLowerCase();
      if (resp.status === 404 || resp.status === 405 || !contentType.includes('application/json')) {
        backendMode = 'direct';
        return { available: false };
      }
      if (resp.status >= 500) {
        return { available: false, networkError: true };
      }
      const parsed = (await resp.json()) as T;
      backendMode = 'api';
      return { available: true, data: parsed };
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || (err as { name?: string })?.name === 'TimeoutError') {
        timedOut = true;
      }
      if (attempt === 0 && !timedOut) {
        await new Promise((resolve) => setTimeout(resolve, 220));
        continue;
      }
      return { available: false, networkError: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { available: false, networkError: true };
}

async function postAppsScriptWebhook<T = Record<string, unknown>>(
  action: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const webhookUrl = getClientWebhookUrl();
  if (!webhookUrl) {
    throw new Error('尚未設定 Google Apps Script Webhook 網址');
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 15_000) : null;
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...payload }),
      signal: controller?.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`Webhook HTTP ${resp.status}`);
    }
    const parsed = JSON.parse(text) as T;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Webhook 回傳格式錯誤');
    }
    return parsed;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const cloudBridge: CloudBridgeApi = {
  async saveProfileSnapshot(payload) {
    const cleanPayload = { ...payload, saveData: stripSaveSecrets(payload.saveData) };
    const api = await tryApiFetch<Record<string, unknown>>('/api/profile/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cleanPayload),
    });
    if (api.available && api.data) return api.data;
    if (backendMode !== 'direct') {
      return { ok: false, error: '無法連線到雲端試算表伺服器' };
    }

    try {
      const ownerSecretHash = await hashSecretBrowser(payload.ownerSecret);
      return await postAppsScriptWebhook('saveProfile', {
        profileId: payload.profileId,
        nickname: payload.nickname,
        ownerSecretHash,
        saveData: cleanPayload.saveData,
      });
    } catch {
      return { ok: false, error: '無法連線到雲端試算表伺服器' };
    }
  },

  async bindOrRenameNickname(payload) {
    const cleanPayload = { ...payload, saveData: stripSaveSecrets(payload.saveData) };
    const api = await tryApiFetch<Record<string, unknown>>('/api/profile/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cleanPayload),
    });
    if (api.available && api.data) {
      if (api.data.ok) {
        (['timed', 'survival'] as const).forEach((m) => {
          if (memCache[m]) {
            memCache[m]!.entries = memCache[m]!.entries.map((row) =>
              row.profileId === payload.profileId ? { ...row, nickname: payload.nickname } : row
            );
          }
        });
        saveCacheToStorage();
      }
      return api.data;
    }
    if (backendMode !== 'direct') {
      return { ok: false, error: '綁定或改名時連線失敗，請稍後再試' };
    }

    try {
      const ownerSecretHash = await hashSecretBrowser(payload.ownerSecret);
      const res = await postAppsScriptWebhook<Record<string, unknown>>('bindProfile', {
        profileId: payload.profileId,
        nickname: payload.nickname,
        ownerSecretHash,
        saveData: cleanPayload.saveData,
      });
      if (res?.ok) {
        (['timed', 'survival'] as const).forEach((m) => {
          if (memCache[m]) {
            memCache[m]!.entries = memCache[m]!.entries.map((row) =>
              row.profileId === payload.profileId ? { ...row, nickname: payload.nickname } : row
            );
          }
        });
        saveCacheToStorage();
      }
      return res;
    } catch {
      return { ok: false, error: '綁定或改名時連線失敗，請稍後再試' };
    }
  },

  async lookupProfileByNickname(nickname, ownerSecret) {
    const cleanNick = String(nickname || '').trim();
    const cleanSecret = String(ownerSecret || '').trim();
    if (!cleanNick || !cleanSecret) {
      return { ok: false, error: '請同時輸入暱稱與引繼碼才能載入雲端存檔。' };
    }

    const api = await tryApiFetch<{ ok: boolean; profile?: CloudProfile; error?: string }>(
      '/api/profile/lookup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ nickname: cleanNick, ownerSecret: cleanSecret }),
      }
    );
    if (api.available && api.data) return api.data;
    if (backendMode !== 'direct') {
      return { ok: false, error: '搜尋雲端存檔時連線失敗' };
    }

    try {
      const ownerSecretHash = await hashSecretBrowser(cleanSecret);
      const res = await postAppsScriptWebhook<{ ok: boolean; verifiedByCloud?: boolean; profile?: CloudProfile; error?: string }>(
        'lookupProfile',
        { nickname: cleanNick, ownerSecretHash }
      );
      if (!res?.ok) return res;
      if (!res.verifiedByCloud) {
        return { ok: false, error: '雲端腳本尚未啟用引繼碼驗證，請先更新部署 Code.gs 後再載入。' };
      }
      if (res.profile?.saveData) {
        res.profile.saveData = stripSaveSecrets(res.profile.saveData);
      }
      return res;
    } catch {
      return { ok: false, error: '搜尋雲端存檔時連線失敗' };
    }
  },

  async listCloudProfileSlots() {
    // Disabled for account privacy: never expose other players' cloud accounts
    return [];
  },

  getCachedLeaderboard(mode, profileId = '') {
    loadCacheFromStorage();
    const safeMode = mode === 'survival' ? 'survival' : 'timed';
    const bucket = memCache[safeMode];
    if (!bucket || !Array.isArray(bucket.entries)) return [];
    return tagEntriesWithMine(bucket.entries, profileId);
  },

  getCachedChampions(profileId = '') {
    loadCacheFromStorage();
    return formatChampionsForProfile(memCache.champions, profileId);
  },

  async fetchLeaderboardChampions(profileId = '', options = {}) {
    loadCacheFromStorage();
    const force = Boolean(options?.force);
    if (!force && memCache.champions && Date.now() - memCache.championsFetchedAt < CLIENT_CACHE_FRESH_MS) {
      return formatChampionsForProfile(memCache.champions, profileId)!;
    }

    const key = `champions:${force ? 'force' : 'normal'}`;
    if (inflightMap.has(key)) {
      const cachedRes = (await inflightMap.get(key)) as ChampionsPayload;
      return formatChampionsForProfile(cachedRes, profileId) || cachedRes;
    }

    const reqPromise = (async (): Promise<ChampionsPayload> => {
      const api = await tryApiFetch<ChampionsPayload>(
        `/api/leaderboard/champions?profileId=${encodeURIComponent(profileId || '')}${force ? '&force=1' : ''}`,
        { method: 'GET', headers: { Accept: 'application/json' } }
      );
      if (api.available && api.data) {
        if (api.data.ok) {
          memCache.champions = api.data;
          memCache.championsFetchedAt = Date.now();
          saveCacheToStorage();
        }
        return api.data;
      }
      if (backendMode !== 'direct') {
        return formatChampionsForProfile(memCache.champions, profileId) || { ok: false, error: '讀取榜首狀態失敗' };
      }

      try {
        const result = await postAppsScriptWebhook<ChampionsPayload>('getChampions', {});
        if (result?.ok) {
          memCache.champions = result;
          memCache.championsFetchedAt = Date.now();
          saveCacheToStorage();
        }
        return formatChampionsForProfile(result, profileId) || result;
      } catch {
        return formatChampionsForProfile(memCache.champions, profileId) || { ok: false, error: '讀取榜首狀態失敗' };
      }
    })();

    inflightMap.set(key, reqPromise);
    try {
      const result = await reqPromise;
      return formatChampionsForProfile(result, profileId) || result;
    } finally {
      inflightMap.delete(key);
    }
  },

  async fetchLeaderboard(mode, profileId = '', options = {}) {
    loadCacheFromStorage();
    const safeMode = mode === 'survival' ? 'survival' : 'timed';
    const force = Boolean(options?.force);
    const key = `lb:${safeMode}:${force ? 'force' : 'normal'}`;

    if (inflightMap.has(key)) {
      const list = (await inflightMap.get(key)) as LeaderboardEntry[];
      return tagEntriesWithMine(list, profileId);
    }

    const reqPromise = (async (): Promise<LeaderboardEntry[]> => {
      const api = await tryApiFetch<{ ok?: boolean; entries?: LeaderboardEntry[]; champions?: ChampionsPayload }>(
        `/api/leaderboard?mode=${encodeURIComponent(safeMode)}&profileId=${encodeURIComponent(profileId || '')}${force ? '&force=1' : ''}`,
        { method: 'GET', headers: { Accept: 'application/json' } }
      );
      if (api.available && api.data) {
        const list = Array.isArray(api.data.entries) ? api.data.entries : [];
        cacheLeaderboardResult(safeMode, list, api.data.champions || null);
        return list;
      }
      if (backendMode !== 'direct') {
        return memCache[safeMode]?.entries || [];
      }

      try {
        const data = await postAppsScriptWebhook<{ ok?: boolean; entries?: LeaderboardEntry[]; champions?: ChampionsPayload }>('listLeaderboard', {
          mode: safeMode,
        });
        const rawEntries = Array.isArray(data?.entries) ? data.entries : [];
        cacheLeaderboardResult(safeMode, rawEntries, data?.champions || null);
        return rawEntries;
      } catch {
        return memCache[safeMode]?.entries || [];
      }
    })();

    inflightMap.set(key, reqPromise);
    try {
      const list = await reqPromise;
      return tagEntriesWithMine(list, profileId);
    } finally {
      inflightMap.delete(key);
    }
  },

  async prefetchLeaderboards(profileId = '') {
    loadCacheFromStorage();
    const now = Date.now();
    if (!memCache.timed || now - memCache.timed.fetchedAt > CLIENT_CACHE_FRESH_MS) {
      await this.fetchLeaderboard('timed', profileId);
    }
    if (!memCache.survival || now - memCache.survival.fetchedAt > CLIENT_CACHE_FRESH_MS) {
      await this.fetchLeaderboard('survival', profileId);
    }
  },

  async submitEndlessScore(payload) {
    loadCacheFromStorage();
    const safeMode: 'timed' | 'survival' = payload.mode === 'survival' ? 'survival' : 'timed';
    const cleanPayload = {
      ...payload,
      saveData: payload.saveData && typeof payload.saveData === 'object' ? stripSaveSecrets(payload.saveData) : undefined,
    };
    const api = await tryApiFetch<Record<string, unknown>>('/api/leaderboard/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cleanPayload),
    });

    const syncAfterSubmit = (res: Record<string, unknown>) => {
      if (!res || !res.ok) return;
      const serverEntries = Array.isArray(res.entries) ? (res.entries as LeaderboardEntry[]) : null;
      const serverChamps = (res.champions && typeof res.champions === 'object' ? res.champions : null) as ChampionsPayload | null;
      if (serverEntries) {
        cacheLeaderboardResult(safeMode, serverEntries, serverChamps);
      } else {
        const existing = memCache[safeMode]?.entries ? [...memCache[safeMode]!.entries] : [];
        const entryId = String(res.entryId || `${payload.profileId}__${safeMode}`);
        const now = Date.now();
        const nextRow: LeaderboardEntry = {
          id: entryId,
          profileId: payload.profileId,
          nickname: payload.nickname,
          mode: safeMode,
          heroId: payload.heroId,
          heroName: payload.heroName,
          kills: Math.max(0, Math.floor(Number(payload.kills) || 0)),
          survivalSec: Math.max(0, Number(payload.survivalSec) || 0),
          score: Number(payload.score) || 0,
          updatedAt: now,
        };
        const idx = existing.findIndex((r) => r.id === entryId || r.profileId === payload.profileId);
        if (idx >= 0) {
          if (res.improved !== false) existing[idx] = nextRow;
          else existing[idx] = { ...existing[idx], nickname: payload.nickname, updatedAt: now };
        } else {
          existing.push(nextRow);
        }
        cacheLeaderboardResult(safeMode, existing, serverChamps);
      }
    };

    if (api.available && api.data) {
      syncAfterSubmit(api.data);
      return api.data;
    }
    if (backendMode !== 'direct') {
      return { ok: false, error: '上傳排位成績失敗，請稍後再試' };
    }

    try {
      const ownerSecretHash = await hashSecretBrowser(payload.ownerSecret);
      const res = await postAppsScriptWebhook<Record<string, unknown>>('submitScore', {
        profileId: payload.profileId,
        nickname: payload.nickname,
        ownerSecretHash,
        mode: safeMode,
        heroId: String(payload.heroId || 'pudding').slice(0, 40),
        heroName: String(payload.heroName || '夥伴').slice(0, 32),
        kills: Math.max(0, Math.floor(Number(payload.kills) || 0)),
        survivalSec: Math.max(0, Number(payload.survivalSec) || 0),
        score: Number(payload.score) || 0,
        saveData: cleanPayload.saveData || null,
      });
      syncAfterSubmit(res);
      return res;
    } catch {
      return { ok: false, error: '上傳排位成績失敗，請稍後再試' };
    }
  },

  async deleteLeaderboardEntry(payload) {
    loadCacheFromStorage();
    const api = await tryApiFetch<Record<string, unknown>>('/api/leaderboard/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const syncAfterDelete = (res: Record<string, unknown>) => {
      if (!res || !res.ok) return;
      (['timed', 'survival'] as const).forEach((m) => {
        if (memCache[m]) {
          memCache[m]!.entries = memCache[m]!.entries.filter((r) => r.id !== payload.entryId);
          memCache[m]!.fetchedAt = Date.now();
        }
      });
      if (res.champions && typeof res.champions === 'object') {
        memCache.champions = res.champions as ChampionsPayload;
        memCache.championsFetchedAt = Date.now();
      }
      saveCacheToStorage();
    };
    if (api.available && api.data) {
      syncAfterDelete(api.data);
      return api.data;
    }
    if (backendMode !== 'direct') {
      return { ok: false, error: '刪除排位紀錄失敗，請稍後再試' };
    }

    try {
      const ownerSecretHash = await hashSecretBrowser(payload.ownerSecret);
      const res = await postAppsScriptWebhook<Record<string, unknown>>('deleteScore', {
        entryId: payload.entryId,
        profileId: payload.profileId,
        ownerSecretHash,
      });
      syncAfterDelete(res);
      return res;
    } catch {
      return { ok: false, error: '刪除排位紀錄失敗，請稍後再試' };
    }
  },
};

window.Cloud218 = cloudBridge;

export default cloudBridge;
