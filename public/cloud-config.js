/**
 * 218 family survivor — GitHub Pages / 靜態託管可直接修改的雲端試算表設定檔
 * 若日後重新部署 Google Apps Script 並取得新網址，直接修改下方 googleSheetWebhookUrl 即可，不需設定後端環境變數。
 */
window.__CLOUD_CONFIG__ = {
  googleSheetWebhookUrl:
    'https://script.google.com/macros/s/AKfycbxrE9hPJUoKkbqx5YMEPb83AmlXcajlHamkT4AA2Jgt-QKN0tWmL73QGUT0U_bcN18U/exec',
};

// 純靜態託管保底橋接：若直接將倉庫檔案發布到 GitHub Pages（未經過 Vite 打包 src/cloudBridge.ts），
// 仍可自動透過下方直接呼叫 Apps Script Webhook 完成上傳分數、綁定存檔與讀取排行榜；
// 若透過 Vite / dist 部署，src/cloudBridge.ts 會在載入完成後自動接管並優先嘗試 /api/* 與備援 Webhook。
(function () {
  if (window.Cloud218) return;

  async function hashSecret(secret) {
    var raw = String(secret || '').trim();
    if (!raw) return '';
    try {
      if (window.crypto && window.crypto.subtle) {
        var encoded = new TextEncoder().encode(raw);
        var digest = await window.crypto.subtle.digest('SHA-256', encoded);
        return Array.from(new Uint8Array(digest))
          .map(function (b) { return b.toString(16).padStart(2, '0'); })
          .join('');
      }
    } catch (_) {}
    var h1 = 0x811c9dc5;
    for (var i = 0; i < raw.length; i++) {
      h1 ^= raw.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193);
    }
    return 'fnv_' + (h1 >>> 0).toString(16);
  }

  async function postWebhook(action, payload) {
    var url = String((window.__CLOUD_CONFIG__ && window.__CLOUD_CONFIG__.googleSheetWebhookUrl) || '').trim();
    if (!url) throw new Error('尚未設定 Google Apps Script Webhook 網址');
    var resp = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    });
    var text = await resp.text();
    if (!resp.ok) throw new Error('Webhook HTTP ' + resp.status);
    var parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('Webhook 回傳格式錯誤');
    return parsed;
  }

  var CACHE_KEY = '218fs_lb_cache_v1';
  var mem = { timed: null, survival: null, champions: null };

  function loadMem() {
    if (mem.timed || mem.survival) return;
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.timed) mem.timed = parsed.timed;
        if (parsed && parsed.survival) mem.survival = parsed.survival;
        if (parsed && parsed.champions) mem.champions = parsed.champions;
      }
    } catch (_) {}
  }

  function saveMem() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(mem)); } catch (_) {}
  }

  function tagMine(entries, pid) {
    return (entries || []).map(function (entry) {
      return Object.assign({}, entry, {
        isMine: Boolean(pid && String(entry.profileId || '') === pid),
      });
    });
  }

  window.Cloud218 = {
    async saveProfileSnapshot(payload) {
      try {
        var ownerSecretHash = await hashSecret(payload && payload.ownerSecret);
        return await postWebhook('saveProfile', {
          profileId: payload.profileId,
          nickname: payload.nickname,
          ownerSecretHash: ownerSecretHash,
          saveData: (payload && payload.saveData) || {},
        });
      } catch (_) {
        return { ok: false, error: '無法連線到雲端試算表伺服器' };
      }
    },
    async bindOrRenameNickname(payload) {
      try {
        var ownerSecretHash = await hashSecret(payload && payload.ownerSecret);
        return await postWebhook('bindProfile', {
          profileId: payload.profileId,
          nickname: payload.nickname,
          ownerSecretHash: ownerSecretHash,
          saveData: (payload && payload.saveData) || {},
        });
      } catch (_) {
        return { ok: false, error: '綁定或改名時連線失敗，請稍後再試' };
      }
    },
    async lookupProfileByNickname(nickname) {
      try {
        return await postWebhook('lookupProfile', { nickname: nickname || '' });
      } catch (_) {
        return { ok: false, error: '搜尋雲端存檔時連線失敗' };
      }
    },
    async listCloudProfileSlots() {
      try {
        var data = await postWebhook('listSlots', {});
        return Array.isArray(data && data.slots) ? data.slots : [];
      } catch (_) {
        return [];
      }
    },
    getCachedLeaderboard(mode, profileId) {
      loadMem();
      var safeMode = mode === 'survival' ? 'survival' : 'timed';
      var b = mem[safeMode];
      return tagMine(b && Array.isArray(b.entries) ? b.entries : [], profileId || '');
    },
    getCachedChampions(profileId) {
      loadMem();
      if (!mem.champions) return null;
      var pid = profileId || '';
      return Object.assign({}, mem.champions, {
        timedRank1: Boolean(pid && String(mem.champions.timedProfileId || '') === pid),
        survivalRank1: Boolean(pid && String(mem.champions.survivalProfileId || '') === pid),
      });
    },
    async fetchLeaderboardChampions(profileId) {
      try {
        var pid = profileId || '';
        var result = await postWebhook('getChampions', {});
        if (result && result.ok) {
          mem.champions = result;
          saveMem();
        }
        return Object.assign({}, result, {
          timedRank1: Boolean(pid && String(result.timedProfileId || '') === pid),
          survivalRank1: Boolean(pid && String(result.survivalProfileId || '') === pid),
        });
      } catch (_) {
        return this.getCachedChampions(profileId) || { ok: false, error: '讀取榜首狀態失敗' };
      }
    },
    async fetchLeaderboard(mode, profileId) {
      loadMem();
      var safeMode = mode === 'survival' ? 'survival' : 'timed';
      try {
        var pid = profileId || '';
        var data = await postWebhook('listLeaderboard', { mode: safeMode });
        var raw = Array.isArray(data && data.entries) ? data.entries : [];
        mem[safeMode] = { entries: raw, fetchedAt: Date.now() };
        if (data && data.champions) mem.champions = data.champions;
        saveMem();
        return tagMine(raw, pid);
      } catch (_) {
        return this.getCachedLeaderboard(safeMode, profileId);
      }
    },
    async prefetchLeaderboards(profileId) {
      await Promise.allSettled([
        this.fetchLeaderboard('timed', profileId),
        this.fetchLeaderboard('survival', profileId),
      ]);
    },
    async submitEndlessScore(payload) {
      try {
        var ownerSecretHash = await hashSecret(payload && payload.ownerSecret);
        var res = await postWebhook('submitScore', {
          profileId: payload.profileId,
          nickname: payload.nickname,
          ownerSecretHash: ownerSecretHash,
          mode: payload.mode === 'survival' ? 'survival' : 'timed',
          heroId: String(payload.heroId || 'pudding').slice(0, 40),
          heroName: String(payload.heroName || '夥伴').slice(0, 32),
          kills: Math.max(0, Math.floor(Number(payload.kills) || 0)),
          survivalSec: Math.max(0, Number(payload.survivalSec) || 0),
          score: Number(payload.score) || 0,
          saveData: payload.saveData && typeof payload.saveData === 'object' ? payload.saveData : null,
        });
        if (res && res.ok) {
          var safeMode = payload.mode === 'survival' ? 'survival' : 'timed';
          if (Array.isArray(res.entries)) mem[safeMode] = { entries: res.entries, fetchedAt: Date.now() };
          if (res.champions) mem.champions = res.champions;
          saveMem();
        }
        return res;
      } catch (_) {
        return { ok: false, error: '上傳排位成績失敗，請稍後再試' };
      }
    },
    async deleteLeaderboardEntry(payload) {
      try {
        var ownerSecretHash = await hashSecret(payload && payload.ownerSecret);
        var res = await postWebhook('deleteScore', {
          entryId: payload.entryId,
          profileId: payload.profileId,
          ownerSecretHash: ownerSecretHash,
        });
        if (res && res.ok) {
          ['timed', 'survival'].forEach(function (m) {
            if (mem[m] && Array.isArray(mem[m].entries)) {
              mem[m].entries = mem[m].entries.filter(function (r) { return r.id !== payload.entryId; });
            }
          });
          if (res.champions) mem.champions = res.champions;
          saveMem();
        }
        return res;
      } catch (_) {
        return { ok: false, error: '刪除排位紀錄失敗，請稍後再試' };
      }
    },
  };
})();
