// 生成一张 1024x1024 的应用图标源图（PNG），供 `npx tauri icon` 切各种尺寸。
//
// 不引第三方绘图库：一张纯色几何图形用 zlib + 手写 PNG 分块就够了，
// 免得为了一个图标往项目里塞 canvas / sharp 这种重依赖。
//
// 用法：node scripts/make-icon.mjs <输出路径>
//
// ## 外形为什么是梯形
//
// 前几版是「蓝色圆角方块 + 里面放一个日历」——也就是所有日历应用共用的
// 那张图：一个方形底板，把内容装在中间。方形底板在这里没有信息量，
// 它只是把图标缩小了一圈、还多了一圈和系统主题打架的底色。
//
// 现在让**形状本身就是日历**，并且斜切掉左上角：
//
//   * 斜切直接取自悬浮块（`float-window.tsx` 里那条 `clip-path`）——
//     悬浮块是这个软件在屏幕上唯一常驻的东西，拿它的轮廓当图标，
//     等于图标和软件是同一个记号，而不是随便找个日历符号。
//   * 两个挂环**戳出**轮廓之外。这是最省的一笔「这是日历」的暗示，
//     同时也让剪影在任何尺寸下都不是一块规规矩矩的方。
//   * 底色仍用蓝色渐变（与标签色 `#3b82f6` 同源），保证图标在深浅
//     两种主题下都立得住——纯白的日历在浅色背景上会糊掉。
//
// 内容刻意只留 3x2 六格：图标最小要在任务栏和托盘里当 16x16 用，
// 九宫格缩到那个尺寸就成了一团麻点，六格还能看清是一格一格的。
// 「今天」那格用实心白，其余半透明——靠不透明度拉开主次，不再引第二种色相。

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;
const OUT = process.argv[2] ?? "app-icon.png";

// 与 src/styles.css 里的标签色保持一致
const BG_TOP = [59, 130, 246]; // #3b82f6
const BG_BOTTOM = [29, 78, 216]; // #1d4ed8，比旧的 #2563eb 再深一档，撑开层次
const WHITE = [255, 255, 255];
const SHADOW = [15, 23, 42]; // slate-900，与界面底色同源

// RGBA，分量 0..255。
//
// 必须是 Uint8Array 而不是 Float32Array：PNG 编码那步是拿它的底层缓冲
// **按字节**拼扫描线的，浮点缓冲会被当成像素直接读走，整张图散成噪点。
// 这里也用不上小数——`set` 每次都四舍五入回整数，抗锯齿精度由掩码承担。
const px = new Uint8Array(SIZE * SIZE * 4);

// source-over 合成，而不是直接覆盖像素。
// 覆盖式写入会让抗锯齿产生的半透明边缘把底下的图层「擦掉」，
// 在形状交界处留下一圈浅色毛边。
const set = (x, y, [r, g, b], a = 255) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;

  const sa = a / 255;
  if (sa <= 0) return;
  const da = px[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;

  px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
  px[i + 3] = Math.round(oa * 255);
};

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// ---------------------------------------------------------------- 覆盖率掩码
//
// 先算「这个像素被形状盖住了百分之几」，再拿这个百分比当 alpha 合成。
// 直接按像素判断内外会有锯齿，而这个脚本没有别的抗锯齿手段。

/** 圆角矩形的内外判定。`r = 0` 时退化成直角矩形。 */
const roundRectInside = (x0, y0, x1, y1, r) => {
  r = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  return (fx, fy) => {
    if (fx < x0 || fy < y0 || fx >= x1 || fy >= y1) return false;
    if (r === 0) return true;
    // 夹到内矩形再比距离，就是在比「到圆角矩形」的距离
    const cx = Math.min(Math.max(fx, x0 + r), x1 - r);
    const cy = Math.min(Math.max(fy, y0 + r), y1 - r);
    return Math.hypot(fx - cx, fy - cy) <= r;
  };
};

/**
 * 按 4x4 超采样算一个形状的覆盖率（0..1，落在 [x0,x1) x [y0,y1) 内）。
 *
 * 只扫包围盒：整张 1024x1024 逐形状扫 16 个采样点是 1600 万次，
 * 十几个形状叠起来要好几秒；限在包围盒内就只是个零头。
 */
function coverage(x0, y0, x1, y1, inside) {
  const m = new Float32Array(SIZE * SIZE);
  const S = 4;
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(SIZE, Math.ceil(x1));
  y1 = Math.min(SIZE, Math.ceil(y1));

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let hits = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          if (inside(x + (sx + 0.5) / S, y + (sy + 0.5) / S)) hits++;
        }
      }
      if (hits > 0) m[y * SIZE + x] = hits / (S * S);
    }
  }
  return m;
}

/** 把覆盖率掩码按某个颜色合成上去。`color` 可以给 (x, y) => [r,g,b] 做渐变。 */
function paintMask(m, x0, y0, x1, y1, color, alpha = 255) {
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(SIZE, Math.ceil(x1));
  y1 = Math.min(SIZE, Math.ceil(y1));

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const c = m[y * SIZE + x];
      if (c === 0) continue;
      set(x, y, typeof color === "function" ? color(x, y) : color, c * alpha);
    }
  }
}

/** 一步画一个圆角矩形。 */
function fillRoundRect(x0, y0, x1, y1, r, color, alpha = 255) {
  paintMask(coverage(x0, y0, x1, y1, roundRectInside(x0, y0, x1, y1, r)), x0, y0, x1, y1, color, alpha);
}

// ------------------------------------------------------------------ 模糊
//
// 只给阴影用。没有模糊的阴影就是一坨黑边，比不加还难看。

/** 横向一遍盒式模糊。窗口外的部分当 0——形状之外本来就什么都没有。 */
function boxBlurH(src, dst, r) {
  const n = 2 * r + 1;
  for (let y = 0; y < SIZE; y++) {
    const row = y * SIZE;
    let sum = 0;
    for (let x = 0; x <= r && x < SIZE; x++) sum += src[row + x];

    for (let x = 0; x < SIZE; x++) {
      dst[row + x] = sum / n;
      const out = x - r;
      const inn = x + r + 1;
      if (out >= 0) sum -= src[row + out];
      if (inn < SIZE) sum += src[row + inn];
    }
  }
}

/** 纵向一遍盒式模糊。 */
function boxBlurV(src, dst, r) {
  const n = 2 * r + 1;
  for (let x = 0; x < SIZE; x++) {
    let sum = 0;
    for (let y = 0; y <= r && y < SIZE; y++) sum += src[y * SIZE + x];

    for (let y = 0; y < SIZE; y++) {
      dst[y * SIZE + x] = sum / n;
      const out = y - r;
      const inn = y + r + 1;
      if (out >= 0) sum -= src[out * SIZE + x];
      if (inn < SIZE) sum += src[inn * SIZE + x];
    }
  }
}

/** 跑三遍盒式模糊近似高斯。就地改 `mask` 并返回它。 */
function blur(mask, r) {
  const tmp = new Float32Array(SIZE * SIZE);
  for (let p = 0; p < 3; p++) {
    boxBlurH(mask, tmp, r);
    boxBlurV(tmp, mask, r);
  }
  return mask;
}

// ============================================================== 开始画

// 主体：一块斜切掉左上角的矩形。斜切量 240/904 ≈ 27%，与悬浮块的
// `clip-path: polygon(30% 0, ...)` 是一个比例。
const BX0 = 60;
const BY0 = 96;
const BX1 = 964;
const BY1 = 988;
const BODY_R = 36; // 其余三个角留一点点圆，免得整块看着太生硬
const CHAMFER = 240;

const bodyInside = (fx, fy) => {
  // (fx-BX0) + (fy-BY0) < CHAMFER 的那一侧就是被切掉的角：
  // 那条斜线正是 (fx-BX0)+(fy-BY0) = CHAMFER
  if (fx - BX0 + (fy - BY0) < CHAMFER) return false;
  return roundRectInside(BX0, BY0, BX1, BY1, BODY_R)(fx, fy);
};

// 两个挂环。**与主体同色、连成一体**，不画成白色。
//
// 白挂环在这里是行不通的：它戳出主体顶边的那半截落在外面的透明区上，
// 浅色背景里就消失了，只剩陷进主体的那半截——看上去不像挂环，
// 倒像在顶边挖了两个洞，整个图形会被读成一张行李牌。
//
// 同色之后剪影变成「一块斜切矩形 + 顶上两个凸起」，本来就是日历最经典的
// 外形；也省掉了两色交界处要处理的那道缝。
// 做得偏粗：图标最小要在任务栏和托盘里当 16x16 用，那时候一个挂环
// 只有三四个像素宽，窄一点就化没了。
const RING_R = 57;
const RINGS = [
  [435, 4, 550, 190],
  [715, 4, 830, 190],
];

const ringInside = (fx, fy) =>
  RINGS.some(([x0, y0, x1, y1]) => roundRectInside(x0, y0, x1, y1, RING_R)(fx, fy));

// 剪影 = 主体 ∪ 挂环。合成一份，是为了让两者共用同一道渐变、同一道阴影，
// 不然挂环会缺一块底色、也不投影，在交界处露馅。
const silhouette = (fx, fy) => bodyInside(fx, fy) || ringInside(fx, fy);

const SIL_X0 = BX0;
const SIL_Y0 = 4; // 挂环顶端
const SIL_X1 = BX1;
const SIL_Y1 = BY1;
const silMask = coverage(SIL_X0, SIL_Y0, SIL_X1, SIL_Y1, silhouette);

// 1) 阴影：把剪影的掩码往下挪一点、模糊、压暗，垫在底下。
//    往下挪是为了让它只从下方透出来，不至于在四周糊成一圈黑边。
const SHADOW_DY = 22;
const shadowMask = new Float32Array(SIZE * SIZE);
for (let y = 0; y < SIZE - SHADOW_DY; y++) {
  const src = y * SIZE;
  const dst = (y + SHADOW_DY) * SIZE;
  for (let x = 0; x < SIZE; x++) shadowMask[dst + x] = silMask[src + x];
}
blur(shadowMask, 16);
// 0..SIZE 整幅扫一遍：阴影已经被模糊到到处都是，包围盒限制没意义了
paintMask(shadowMask, 0, 0, SIZE, SIZE, SHADOW, 90);

// 2) 主体。渐变走对角而不是垂直——梯形的高光落在左下到右上这条对角线上，
//    比上下均分更有立体感。挂环在主体上方，那一带的 t 仍为正（它们起点
//    在 x=445 附近），夹一下是防手滑改常量时算出界外的颜色。
const W = BX1 - BX0 + (BY1 - BY0);
paintMask(silMask, SIL_X0, SIL_Y0, SIL_X1, SIL_Y1, (x, y) => {
  const t = Math.min(1, Math.max(0, (x - BX0 + (y - BY0)) / W));
  return mix(BG_TOP, BG_BOTTOM, t);
});

// 4) 日期格：3 列 x 2 行，整体压在主体下半部——左上角是斜切，内容自然让开。
//    「今天」那格实心白，其余半透明；靠不透明度分主次，不引第二种色相。
const CELL = 220;
const GAP = 52;
const GRID_X = 130;
const GRID_Y = 300;
for (let row = 0; row < 2; row++) {
  for (let col = 0; col < 3; col++) {
    const x = GRID_X + col * (CELL + GAP);
    const y = GRID_Y + row * (CELL + GAP);
    const isToday = row === 0 && col === 1;
    fillRoundRect(x, y, x + CELL, y + CELL, 44, WHITE, isToday ? 255 : 110);
  }
}

// ---- PNG 编码 ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // 位深
ihdr[9] = 6; // 颜色类型 6 = RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

// 每条扫描线前面加一个 filter 字节（0 = None）
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(OUT, png);
console.log(`已生成 ${OUT}（${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB）`);
