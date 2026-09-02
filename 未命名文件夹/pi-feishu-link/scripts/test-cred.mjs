import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/feishu-link/config.json", "utf8"));
const base = cfg.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
console.log("appId:", cfg.appId.slice(0, 10) + "...", "| secret 长度:", String(cfg.appSecret).length);
// 1) 获取 tenant_access_token
const tok = await fetch(base + "/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
});
const tokBody = await tok.json();
console.log("token 获取:", tokBody.code === 0 ? "✅ 成功" : `❌ code=${tokBody.code} msg=${tokBody.msg}`);
if (tokBody.code !== 0) process.exit(1);
// 2) 用 token 查 bot 信息
const info = await fetch(base + "/open-apis/bot/v3/info", {
  headers: { Authorization: "Bearer " + tokBody.tenant_access_token },
});
const infoBody = await info.json();
console.log("bot 信息:", infoBody.code === 0 ? "✅ " + JSON.stringify(infoBody.bot ?? infoBody.data).slice(0, 200) : `❌ code=${infoBody.code} msg=${infoBody.msg}`);
