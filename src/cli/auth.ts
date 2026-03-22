// ============================================================
// Threads OAuth認証フロー
// ============================================================
// 1. ブラウザでThreads認証画面を開く
// 2. ユーザーが権限を許可
// 3. ローカルサーバーでコールバックを受け取る
// 4. 認証コードをアクセストークンに交換
// 5. 短期トークンを長期トークンに交換
// 6. .envファイルに保存
// ============================================================

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dir, "../..");
const ENV_PATH = join(PROJECT_ROOT, ".env");

const APP_ID = process.env.THREADS_APP_ID ?? "";
const APP_SECRET = process.env.THREADS_APP_SECRET ?? "";
const REDIRECT_URI = "https://sticker.github.io/agent-sns/callback/";
const SCOPES = [
  "threads_basic",
  "threads_content_publish",
  "threads_manage_insights",
  "threads_read_replies",
  "threads_manage_replies",
  "threads_keyword_search",
].join(",");

if (!APP_ID || !APP_SECRET) {
  console.error("エラー: .env に THREADS_APP_ID と THREADS_APP_SECRET を設定してください");
  process.exit(1);
}

// --- 認証URL生成 ---

const authUrl = `https://threads.net/oauth/authorize?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&response_type=code`;

console.log("\n=== Threads OAuth 認証 ===\n");
console.log("ブラウザで認証画面を開きます...\n");

// ブラウザを開く
Bun.spawn(["open", authUrl]);

// --- ローカルサーバーでコールバック受信 ---

const server = Bun.serve({
  port: 3847,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname !== "/callback") {
      return new Response("Not found", { status: 404 });
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      console.error(`\n認証エラー: ${error}`);
      server.stop();
      process.exit(1);
    }

    if (!code) {
      return new Response("認証コードがありません", { status: 400 });
    }

    console.log("認証コードを受け取りました。トークンを取得中...\n");

    try {
      // Step 1: 認証コード → 短期アクセストークン
      const tokenRes = await fetch("https://graph.threads.net/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: APP_ID,
          client_secret: APP_SECRET,
          grant_type: "authorization_code",
          redirect_uri: REDIRECT_URI,
          code,
        }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        throw new Error(`短期トークン取得失敗: ${err}`);
      }

      const tokenData = (await tokenRes.json()) as {
        access_token: string;
        user_id: string;
      };

      console.log(`短期トークン取得成功 (user_id: ${tokenData.user_id})`);

      // Step 2: 短期トークン → 長期トークン（60日有効）
      const longTokenRes = await fetch(
        `https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${APP_SECRET}&access_token=${tokenData.access_token}`
      );

      if (!longTokenRes.ok) {
        const err = await longTokenRes.text();
        throw new Error(`長期トークン取得失敗: ${err}`);
      }

      const longTokenData = (await longTokenRes.json()) as {
        access_token: string;
        expires_in: number;
      };

      const expiryDays = Math.round(longTokenData.expires_in / 86400);
      console.log(`長期トークン取得成功（有効期限: ${expiryDays}日間）\n`);

      // Step 3: .envファイルに保存
      let envContent = readFileSync(ENV_PATH, "utf-8");

      // THREADS_ACCESS_TOKEN を更新
      if (envContent.includes("THREADS_ACCESS_TOKEN=")) {
        envContent = envContent.replace(
          /THREADS_ACCESS_TOKEN=.*/,
          `THREADS_ACCESS_TOKEN=${longTokenData.access_token}`
        );
      } else {
        envContent += `\nTHREADS_ACCESS_TOKEN=${longTokenData.access_token}`;
      }

      // THREADS_USER_ID を更新
      if (envContent.includes("THREADS_USER_ID=")) {
        envContent = envContent.replace(
          /THREADS_USER_ID=.*/,
          `THREADS_USER_ID=${tokenData.user_id}`
        );
      } else {
        envContent += `\nTHREADS_USER_ID=${tokenData.user_id}`;
      }

      writeFileSync(ENV_PATH, envContent);

      console.log(".env を更新しました:");
      console.log(`  THREADS_ACCESS_TOKEN = ${longTokenData.access_token.slice(0, 20)}...`);
      console.log(`  THREADS_USER_ID = ${tokenData.user_id}`);
      console.log(`\nトークンは${expiryDays}日後に期限切れになります。`);
      console.log("期限が近づいたら再度 bun run auth を実行してください。\n");

      server.stop();

      return new Response(
        `<html><body style="font-family:sans-serif;text-align:center;padding:60px;">
          <h1>認証成功</h1>
          <p>アクセストークンを取得しました。このタブは閉じてOKです。</p>
        </body></html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`\nエラー: ${msg}`);
      server.stop();
      process.exit(1);
    }
  },
});

console.log(`コールバック待ち受け中: ${REDIRECT_URI}`);
console.log("ブラウザで認証を完了してください...\n");
