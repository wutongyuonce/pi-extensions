// 像素画封面生成器 v2：可读文字 + 精细像素图标（Pi 终端 × 飞书 Logo）
// 输出 assets/preview.svg + 供 sharp 转 preview.png
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const W = 80; // 像素图网格宽
const H = 30;
const SCALE = 12; // 每像素 12px → 960x360 主体
const OX = 120; // 主体水平偏移（1200 宽居中）
const OY = 220; // 主体垂直偏移

const PAL = {
	B: "#0b1026",
	c: "#4dd7fe", // 青（连接/终端框）
	P: "#37d67a", // Pi 绿
	g: "#1d5c3a",
	G: "#0f2f20",
	F: "#3370ff", // 飞书蓝
	f: "#1e4bb8",
	d: "#8fb3ff",
	W: "#ffffff",
	y: "#ffd54a",
	o: "#ff9d45",
	r: "#ff5d8f",
	s: "#7ee0ff",
};

const grid = Array.from({ length: H }, () =>
	Array.from({ length: W }, () => "B"),
);
function fill(x0, y0, w, h, k) {
	for (let y = y0; y < Math.min(H, y0 + h); y++)
		for (let x = x0; x < Math.min(W, x0 + w); x++) grid[y][x] = k;
}
function px(x, y, k) {
	if (x >= 0 && x < W && y >= 0 && y < H) grid[y][x] = k;
}

// ============ 1) Pi 终端（x 8-31, y 5-24）============
// 窗口外框（青色，2 像素边框）
fill(8, 5, 24, 20, "c");
fill(10, 7, 20, 16, "G");
// 标题栏（深绿 + 三圆点）
fill(10, 7, 20, 3, "g");
px(12, 8, "r");
px(14, 8, "y");
px(16, 8, "P");
// 标题栏文字点（白点模拟 "pi"）
px(19, 8, "W");
px(20, 8, "W");
// 代码区（深底）
fill(10, 10, 20, 11, "#0d2418");
// 提示符 + 代码行
// 行1: > 提示符 + 绿代码块
px(12, 12, "P");
px(13, 12, "P");
for (let i = 15; i <= 27; i++) px(i, 12, i % 3 === 0 ? "P" : "g");
// 行2: > + 黄代码
px(12, 14, "P");
px(13, 14, "P");
for (let i = 15; i <= 24; i++) px(i, 14, i % 4 === 0 ? "y" : "g");
// 行3: 青色代码
for (let i = 14; i <= 22; i += 2) px(i, 16, "s");
// 行4: 彩色块（模拟输出）
fill(15, 18, 3, 1, "P");
fill(19, 18, 4, 1, "y");
fill(24, 18, 3, 1, "s");
// 底部状态条（绿）
fill(10, 21, 20, 2, "g");
for (let i = 12; i < 17; i++) px(i, 21, "P");
// 窗口阴影（右下像素光）
px(9, 24, "s");

// ============ 2) 飞书 Logo（x 48-71, y 5-24）============
// 蓝色圆角方块（大）
fill(49, 5, 22, 20, "F");
px(49, 5, "B");
px(70, 5, "B");
px(49, 24, "B");
px(70, 24, "B"); // 圆角
// 白色图形：官方飞书 logo 的"纸飞机/流线"——中心白色斜线 + 折角
// 主翼（左上→右下 45° 白色带）
for (let i = 0; i < 10; i++) {
	px(54 + i, 8 + i, "W");
	px(54 + i, 9 + i, "W");
}
// 下翼（水平白色条）
fill(54, 18, 12, 2, "W");
// 折角（右上小翼）
px(63, 12, "W");
px(64, 12, "W");
px(64, 13, "W");
px(65, 13, "W");
// 高光（左上角蓝色渐变）
px(50, 6, "d");
px(51, 6, "d");
px(50, 7, "d");
// 底部小气泡（对话框）
fill(60, 22, 6, 2, "d");
// 光晕点
px(48, 4, "s");

// ============ 3) 双向桥接箭头（x 32-47, y 12-16）============
// 双线连接
for (let x = 33; x < 47; x++) {
	px(x, 13, "c");
	px(x, 14, "c");
}
// 左箭头（指向终端）
px(32, 12, "c");
px(33, 12, "c");
px(32, 15, "c");
px(33, 15, "c");
// 右箭头（指向飞书）
px(46, 12, "c");
px(47, 12, "c");
px(46, 15, "c");
px(47, 15, "c");
// 数据包（黄/橙，沿箭头流动）
px(36, 13, "y");
px(37, 13, "y");
px(42, 14, "o");
// 双向白色标记（"⇄" 简化：上下小箭头）
px(39, 12, "W");
px(40, 12, "W");
px(39, 15, "W");
px(40, 15, "W");
// 连接光晕
px(35, 12, "s");
px(44, 15, "s");

// ============ 4) 底部像素云 + 装饰（y 26-29）============
// 左云
fill(4, 27, 6, 2, "s");
fill(5, 26, 4, 1, "s");
// 右云
fill(70, 27, 6, 2, "s");
fill(71, 26, 4, 1, "s");
// 底部光点行
let seed = 7;
function rnd() {
	seed = (seed * 1103515245 + 12345) % 2147483648;
	return seed / 2147483648;
}
for (let x = 2; x < W - 2; x += 3) {
	if (rnd() > 0.4) px(x, 29, rnd() > 0.5 ? "s" : "W");
}
// 背景星点（稀疏）
for (let i = 0; i < 40; i++) {
	const x = Math.floor(rnd() * W);
	const y = Math.floor(rnd() * H);
	if (grid[y][x] === "B") grid[y][x] = rnd() > 0.6 ? "s" : "B";
}

// ============ 输出 SVG（渐变背景 + 像素图 + 可读文字）============
const rects = [];
for (let y = 0; y < H; y++)
	for (let x = 0; x < W; x++) {
		const k = grid[y][x];
		if (k === "B") continue;
		rects.push(
			`<rect x="${OX + x * SCALE}" y="${OY + y * SCALE}" width="${SCALE}" height="${SCALE}" fill="${PAL[k] ?? "#fff"}"/>`,
		);
	}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="#0b1026"/>
<stop offset="55%" stop-color="#151a3d"/>
<stop offset="100%" stop-color="#241a4e"/>
</linearGradient>
<linearGradient id="title" x1="0" y1="0" x2="1" y2="0">
<stop offset="0%" stop-color="#37d67a"/>
<stop offset="55%" stop-color="#4dd7fe"/>
<stop offset="100%" stop-color="#3370ff"/>
</linearGradient>
<linearGradient id="sub" x1="0" y1="0" x2="1" y2="0">
<stop offset="0%" stop-color="#7ee0ff"/>
<stop offset="100%" stop-color="#8fb3ff"/>
</linearGradient>
</defs>
<rect width="1200" height="630" fill="url(#bg)"/>
<!-- 像素网格纹理（细线） -->
<g stroke="#ffffff08" stroke-width="1">
${Array.from({ length: 24 }, (_, i) => `<line x1="${i * 50}" y1="0" x2="${i * 50}" y2="630"/>`).join("")}
${Array.from({ length: 13 }, (_, i) => `<line x1="0" y1="${i * 50}" x2="1200" y2="${i * 50}"/>`).join("")}
</g>
<!-- 顶部角标 -->
<rect x="1035" y="36" width="130" height="34" rx="17" fill="#ffffff14"/>
<text x="1100" y="59" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="15" fill="#8fb3ff" text-anchor="middle">pi-feishu-link</text>
<!-- 主标题 -->
<text x="60" y="118" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="64" font-weight="700" fill="url(#title)">Pi × Feishu Link</text>
<!-- 副标题（中文，可读） -->
<text x="62" y="168" font-family="system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif" font-size="26" fill="url(#sub)">飞书/Lark 双向桥接扩展 · 扫码即用 · 消息零丢失 · 流式输出</text>
<!-- 像素主体 -->
${rects.join("")}
<!-- 底部小字 -->
<text x="60" y="600" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="15" fill="#5b6c9e">/feishu setup → 30s 上线 · daemon 常驻 · Outbox 可靠投递 · v0.2.0</text>
</svg>`;

mkdirSync(join(process.cwd(), "assets"), { recursive: true });
writeFileSync(join(process.cwd(), "assets", "preview.svg"), svg);
console.log(`preview.svg v2 已生成 (${W}x${H} 像素主体 + 可读文字)`);
