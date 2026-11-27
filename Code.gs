/**
 * 218 family survivor — 共編 Google 試算表後端（Google Apps Script）
 * 部署步驟：
 * 1. 開啟你的共編 Google 試算表 -> 擴充功能 -> Apps Script
 * 2. 貼上本程式並儲存
 * 3. 部署 -> 新增部署作業 -> 類型選「網頁應用程式」
 *    - 執行身分：我
 *    - 誰可以存取：所有人
 * 4. 複製網頁應用程式網址，填入伺服器環境變數 GOOGLE_SHEET_WEBHOOK_URL，
 *    以及純前端設定檔 public/cloud-config.js 與 src/cloudConfig.ts（GitHub Pages 靜態發布時使用）
 */

const PROFILE_SHEET_NAME = 'Profiles';
const LEADERBOARD_SHEET_NAME = 'Leaderboard';

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }
  return sheet;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function normNick(raw) {
  return String(raw || '').replace(/[\r\n\t<>]/g, '').trim().slice(0, 16);
}

function stripSaveSecrets(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const clone = Object.assign({}, raw);
  delete clone.profileSecret;
  delete clone.ownerSecret;
  delete clone.ownerSecretHash;
  return clone;
}

function constantTimeEqual(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (!sa || !sb || sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

function readAllRows(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values[0];
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const obj = { _rowIndex: r + 1 };
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = values[r][c];
    }
    rows.push(obj);
  }
  return rows;
}

function isBetter(nextKills, nextSec, prevKills, prevSec, mode) {
  if (mode === 'timed') {
    if (nextKills !== prevKills) return nextKills > prevKills;
    return nextSec > prevSec;
  }
  if (nextSec !== prevSec) return nextSec > prevSec;
  return nextKills > prevKills;
}

function computeChampionsFromRows(rows) {
  const timedRows = rows
    .filter((r) => String(r.mode) === 'timed')
    .sort((a, b) => (Number(b.kills) - Number(a.kills)) || (Number(b.survivalSec) - Number(a.survivalSec)) || (Number(a.updatedAt) - Number(b.updatedAt)));
  const survivalRows = rows
    .filter((r) => String(r.mode) === 'survival')
    .sort((a, b) => (Number(b.survivalSec) - Number(a.survivalSec)) || (Number(b.kills) - Number(a.kills)) || (Number(a.updatedAt) - Number(b.updatedAt)));
  const timedTop = timedRows[0];
  const survivalTop = survivalRows[0];
  return {
    timedProfileId: timedTop ? String(timedTop.profileId || '') : '',
    timedNickname: timedTop ? String(timedTop.nickname || '') : '',
    survivalProfileId: survivalTop ? String(survivalTop.profileId || '') : '',
    survivalNickname: survivalTop ? String(survivalTop.nickname || '') : ''
  };
}

function formatModeEntries(rows, mode) {
  return rows
    .filter((r) => String(r.mode) === mode)
    .map((r) => ({
      id: String(r.id),
      profileId: String(r.profileId),
      nickname: String(r.nickname || '無名勇者'),
      mode,
      heroId: String(r.heroId || ''),
      heroName: String(r.heroName || '夥伴'),
      kills: Number(r.kills) || 0,
      survivalSec: Number(r.survivalSec) || 0,
      score: Number(r.score) || 0,
      updatedAt: Number(r.updatedAt) || 0
    }))
    .sort((a, b) => {
      if (mode === 'timed') {
        if (b.kills !== a.kills) return b.kills - a.kills;
        if (b.survivalSec !== a.survivalSec) return b.survivalSec - a.survivalSec;
        return a.updatedAt - b.updatedAt;
      }
      if (b.survivalSec !== a.survivalSec) return b.survivalSec - a.survivalSec;
      if (b.kills !== a.kills) return b.kills - a.kills;
      return a.updatedAt - b.updatedAt;
    })
    .slice(0, 100);
}

function computeChampions(lbSheet) {
  return computeChampionsFromRows(readAllRows(lbSheet));
}

function doGet() {
  return jsonOut({
    ok: true,
    service: '218-family-survivor-webhook',
    message: 'Google Apps Script Webhook is active. Use POST with JSON action payload.'
  });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = body.action;
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const pSheet = getOrCreateSheet(ss, PROFILE_SHEET_NAME, [
      'profileId', 'nickname', 'nicknameKey', 'ownerSecretHash', 'saveJson', 'summaryJson', 'updatedAt'
    ]);
    const lbSheet = getOrCreateSheet(ss, LEADERBOARD_SHEET_NAME, [
      'id', 'profileId', 'ownerSecretHash', 'nickname', 'mode', 'heroId', 'heroName', 'kills', 'survivalSec', 'score', 'updatedAt'
    ]);

    if (action === 'getChampions') {
      return jsonOut({ ok: true, ...computeChampions(lbSheet) });
    }

    if (action === 'listSlots') {
      return jsonOut({ ok: true, slots: [] });
    }

    if (action === 'lookupProfile') {
      const nickname = normNick(body.nickname);
      const key = nickname.toLowerCase();
      const secretHash = String(body.ownerSecretHash || '').trim();
      if (!nickname || !secretHash) {
        return jsonOut({ ok: false, error: '請同時輸入暱稱與引繼碼才能載入雲端存檔。' });
      }
      const match = readAllRows(pSheet).find((p) => String(p.nicknameKey || '') === key);
      if (!match || !match.ownerSecretHash || !constantTimeEqual(String(match.ownerSecretHash), secretHash)) {
        return jsonOut({ ok: false, error: '暱稱不存在或引繼碼錯誤，無法載入該雲端存檔。' });
      }
      let saveData = {};
      let summary = {};
      try { saveData = stripSaveSecrets(JSON.parse(match.saveJson || '{}')); } catch {}
      try { summary = JSON.parse(match.summaryJson || '{}'); } catch {}
      return jsonOut({
        ok: true,
        verifiedByCloud: true,
        profile: {
          profileId: String(match.profileId),
          nickname: String(match.nickname),
          saveData,
          summary,
          updatedAt: Number(match.updatedAt) || 0
        }
      });
    }

    if (action === 'bindProfile' || action === 'saveProfile') {
      const profileId = String(body.profileId || '').trim();
      const nickname = normNick(body.nickname);
      const key = nickname.toLowerCase();
      const secretHash = String(body.ownerSecretHash || '').trim();
      const saveData = stripSaveSecrets(body.saveData || {});
      if (!profileId || !nickname || !secretHash) return jsonOut({ ok: false, error: '缺少存檔識別碼、暱稱或引繼碼' });

      const profiles = readAllRows(pSheet);
      const conflict = profiles.find((p) => String(p.nicknameKey || '') === key && String(p.profileId) !== profileId);
      if (conflict) {
        return jsonOut({
          ok: false,
          conflict: true,
          error: `暱稱「${conflict.nickname}」已被其他玩家使用，請改用別的暱稱；若是你自己的帳號，請用「暱稱＋引繼碼」驗證載入。`
        });
      }

      const existing = profiles.find((p) => String(p.profileId) === profileId);
      if (existing && existing.ownerSecretHash && !constantTimeEqual(String(existing.ownerSecretHash), secretHash)) {
        return jsonOut({ ok: false, error: '存檔引繼碼驗證不符，無法覆寫此存檔空間。' });
      }

      const now = Date.now();
      const summary = {
        coins: Number(saveData.coins) || 0,
        milkMice: Number(saveData.milkMice) || 0,
        clearedCount: Array.isArray(saveData.clearedStages) ? saveData.clearedStages.length : 0,
        heroCount: Array.isArray(saveData.unlockedHeroes) ? saveData.unlockedHeroes.length : 0
      };
      const rowValues = [
        profileId,
        nickname,
        key,
        (existing && existing.ownerSecretHash) || secretHash,
        JSON.stringify(saveData),
        JSON.stringify(summary),
        now
      ];
      if (existing) {
        pSheet.getRange(existing._rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
      } else {
        pSheet.appendRow(rowValues);
      }

      // Sync nickname rename across leaderboard rows of this profileId
      const lbRows = readAllRows(lbSheet);
      lbRows.forEach((row) => {
        if (String(row.profileId) === profileId && String(row.nickname) !== nickname) {
          lbSheet.getRange(row._rowIndex, 4).setValue(nickname);
          lbSheet.getRange(row._rowIndex, 11).setValue(now);
        }
      });

      return jsonOut({
        ok: true,
        renamedFrom: existing && existing.nickname !== nickname ? String(existing.nickname) : '',
        profile: { profileId, nickname, updatedAt: now, summary }
      });
    }

    if (action === 'listLeaderboard') {
      const mode = body.mode === 'survival' ? 'survival' : 'timed';
      const allLbRows = readAllRows(lbSheet);
      const entries = formatModeEntries(allLbRows, mode);
      return jsonOut({ ok: true, entries, champions: computeChampionsFromRows(allLbRows) });
    }

    if (action === 'submitScore') {
      const profileId = String(body.profileId || '').trim();
      const nickname = normNick(body.nickname);
      const key = nickname.toLowerCase();
      const mode = body.mode === 'survival' ? 'survival' : 'timed';
      const secretHash = String(body.ownerSecretHash || '').trim();
      const kills = Math.max(0, Number(body.kills) || 0);
      const survivalSec = Math.max(0, Number(body.survivalSec) || 0);
      const score = Number(body.score) || 0;
      const heroId = String(body.heroId || 'pudding');
      const heroName = String(body.heroName || '夥伴');
      if (heroId === 'bigYan') return jsonOut({ ok: false, error: '大皮炎為專屬特別角色，不能拿來打排位賽喔！' });
      if (!profileId || !nickname || !secretHash) return jsonOut({ ok: false, error: '缺少必要資料或存檔引繼碼' });

      const profiles = readAllRows(pSheet);
      const conflict = profiles.find((p) => String(p.nicknameKey || '') === key && String(p.profileId) !== profileId);
      if (conflict) {
        return jsonOut({
          ok: false,
          conflict: true,
          error: `暱稱「${conflict.nickname}」已被其他玩家使用，請更換暱稱；若是你自己的帳號，請用「暱稱＋引繼碼」驗證載入。`
        });
      }

      const now = Date.now();
      const rawSave = body.saveData || null;
      const existingProfile = profiles.find((p) => String(p.profileId) === profileId);
      if (existingProfile && existingProfile.ownerSecretHash && !constantTimeEqual(String(existingProfile.ownerSecretHash), secretHash)) {
        return jsonOut({ ok: false, error: '存檔引繼碼驗證不符，無法提交此存檔成績。' });
      }
      if (rawSave || !existingProfile) {
        const mergedSave = rawSave ? stripSaveSecrets(rawSave) : { profileId, nickname };
        const summary = {
          coins: Number(mergedSave.coins) || 0,
          milkMice: Number(mergedSave.milkMice) || 0,
          clearedCount: Array.isArray(mergedSave.clearedStages) ? mergedSave.clearedStages.length : 0,
          heroCount: Array.isArray(mergedSave.unlockedHeroes) ? mergedSave.unlockedHeroes.length : 0
        };
        const pRow = [
          profileId,
          nickname,
          key,
          (existingProfile && existingProfile.ownerSecretHash) || secretHash,
          JSON.stringify(mergedSave),
          JSON.stringify(summary),
          now
        ];
        if (existingProfile) {
          pSheet.getRange(existingProfile._rowIndex, 1, 1, pRow.length).setValues([pRow]);
        } else {
          pSheet.appendRow(pRow);
        }
      }

      const entryId = `${profileId}__${mode}`;
      const lbRows = readAllRows(lbSheet);
      const existing = lbRows.find((r) => String(r.id) === entryId);
      if (existing && existing.ownerSecretHash && !constantTimeEqual(String(existing.ownerSecretHash), secretHash)) {
        return jsonOut({ ok: false, error: '存檔引繼碼驗證不符，無法更新此榜位紀錄。' });
      }
      lbRows.forEach((row) => {
        if (String(row.profileId) === profileId && String(row.nickname) !== nickname) {
          row.nickname = nickname;
          row.updatedAt = now;
          lbSheet.getRange(row._rowIndex, 4).setValue(nickname);
          lbSheet.getRange(row._rowIndex, 11).setValue(now);
        }
      });
      let improved = true;

      if (existing) {
        const prevKills = Number(existing.kills) || 0;
        const prevSec = Number(existing.survivalSec) || 0;
        if (isBetter(kills, survivalSec, prevKills, prevSec, mode)) {
          lbSheet.getRange(existing._rowIndex, 1, 1, 11).setValues([[
            entryId, profileId, (existing.ownerSecretHash || secretHash), nickname, mode, heroId, heroName, kills, survivalSec, score, now
          ]]);
          existing.nickname = nickname;
          existing.heroId = heroId;
          existing.heroName = heroName;
          existing.kills = kills;
          existing.survivalSec = survivalSec;
          existing.score = score;
          existing.updatedAt = now;
        } else {
          improved = false;
          existing.nickname = nickname;
          existing.updatedAt = now;
          lbSheet.getRange(existing._rowIndex, 4).setValue(nickname);
          lbSheet.getRange(existing._rowIndex, 11).setValue(now);
        }
      } else {
        lbSheet.appendRow([entryId, profileId, secretHash, nickname, mode, heroId, heroName, kills, survivalSec, score, now]);
        lbRows.push({
          id: entryId, profileId, ownerSecretHash: secretHash, nickname, mode, heroId, heroName, kills, survivalSec, score, updatedAt: now
        });
      }

      const entries = formatModeEntries(lbRows, mode);
      const rank = entries.findIndex((r) => String(r.id) === entryId) + 1;
      return jsonOut({
        ok: true,
        entryId,
        rank: rank > 0 ? rank : 1,
        updatedExisting: Boolean(existing),
        improved,
        entries,
        champions: computeChampionsFromRows(lbRows)
      });
    }

    if (action === 'deleteScore') {
      const entryId = String(body.entryId || '').trim();
      const profileId = String(body.profileId || '').trim();
      const secretHash = String(body.ownerSecretHash || '').trim();
      const lbRows = readAllRows(lbSheet);
      const existing = lbRows.find((r) => String(r.id) === entryId);
      if (!existing) return jsonOut({ ok: false, error: '找不到這筆排位紀錄' });
      const storedHash = String(existing.ownerSecretHash || '');
      if (String(existing.profileId) !== profileId || !secretHash || (storedHash && !constantTimeEqual(storedHash, secretHash))) {
        return jsonOut({ ok: false, error: '只能刪除自己的排位成績，不能刪除別人的！' });
      }
      lbSheet.deleteRow(existing._rowIndex);
      const remaining = lbRows.filter((r) => String(r.id) !== entryId);
      return jsonOut({
        ok: true,
        entries: formatModeEntries(remaining, String(existing.mode || 'timed')),
        champions: computeChampionsFromRows(remaining)
      });
    }

    return jsonOut({ ok: false, error: 'Unknown action' });
  } finally {
    lock.releaseLock();
  }
}
