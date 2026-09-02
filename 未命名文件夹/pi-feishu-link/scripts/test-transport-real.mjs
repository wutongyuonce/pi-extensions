import { readFileSync } from "node:fs";
import { Client, WSClient, EventDispatcher } from "@larksuiteoapi/node-sdk";
import { FeishuTransport } from "../src/inbound/transport.ts";
const cfg = JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/feishu-link/config.json", "utf8"));
const sdk = { Client, WSClient, EventDispatcher, Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" } };
const t = new FeishuTransport({ sdk, config: cfg, onMessage: async () => {}, onCardAction: async () => undefined });
await t.start();
console.log("✅ transport.start 成功");
console.log("botOpenId:", t.getBotOpenId());
// 给 WS 握手留时间，观察 SDK 内部是否报 token 错误
await new Promise(r => setTimeout(r, 3000));
const probe = await t.probe();
console.log("probe:", probe.ok ? "✅ ok" : "❌ fail", "latency:", probe.latencyMs + "ms");
await t.stop();
process.exit(probe.ok ? 0 : 1);
