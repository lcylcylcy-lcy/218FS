/**
 * 218 family survivor — 雲端 Google 試算表 Webhook 設定檔
 *
 * 說明：
 * - 在 AI Studio 預覽環境時，後端 server.ts 會優先讀取環境變數 GOOGLE_SHEET_WEBHOOK_URL（若未設定則使用此預設網址）。
 * - 發布到 GitHub Pages 等純前端靜態空間時，瀏覽器無法讀取伺服器端 Secrets 與 /api/* 代理，
 *   會直接改用下方的 Apps Script Web App 網址（亦可透過 public/cloud-config.js 或 VITE_GOOGLE_SHEET_WEBHOOK_URL 覆寫）。
 */
export const DEFAULT_GOOGLE_SHEET_WEBHOOK_URL =
  'https://script.google.com/macros/s/AKfycbxrE9hPJUoKkbqx5YMEPb83AmlXcajlHamkT4AA2Jgt-QKN0tWmL73QGUT0U_bcN18U/exec';

export function getClientWebhookUrl(): string {
  if (typeof window !== 'undefined') {
    const winCfg = (window as Window & { __CLOUD_CONFIG__?: { googleSheetWebhookUrl?: string } }).__CLOUD_CONFIG__;
    const fromWindow = String(winCfg?.googleSheetWebhookUrl || '').trim();
    if (fromWindow) return fromWindow;
  }

  const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const fromViteEnv = String(viteEnv?.VITE_GOOGLE_SHEET_WEBHOOK_URL || '').trim();
  if (fromViteEnv) return fromViteEnv;

  return DEFAULT_GOOGLE_SHEET_WEBHOOK_URL;
}
