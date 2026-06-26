/**
 * main.js — 間接照明剖面模擬器 (純 2D Canvas)
 *
 * 座標系：x=0 左牆，x=W 右牆；y=0 地板，y=H 天花板
 * 左側燈槽：從 x=0 延伸 depth 入室，擋板在 x=depth
 * 右側燈槽：從 x=W 延伸 depth 入室，擋板在 x=W-depth
 */
import { kelvinToColor } from './LightSources.js';

// ══ 全域狀態 ══════════════════════════════════════════════════════
// 長度單位內部一律以「公尺」儲存；UI 以 mm 顯示，於繫結層換算。
const S = {
  room:  { W: 8, H: 3 },
  cove: {
    depth: 0.15, height: 0.40,
    baffleEnabled: true, baffleHeight: 0.12,
    lightWallDist: 0.09, lightPlateDist: 0.20,
    emissionAngle: 180, rotationAngle: 0,
    lightKelvin: 3000, lightIntensity: 800,
  },
  sides: { left: true, right: true },
  wallReflect: { left: true, right: true }, // 槽外主牆面是否反射（關閉＝光線完全穿透）
  refl:  { ceiling: 0.85, wall: 0.75, floor: 0.35 },
  ray:   { density: 20, bounces: 3 },
  eye:   { height: 1.65, xRatio: 0.50, show: true },
  glare: { width: 0.08, height: 0.04, hAnchor: 'wall', vAnchor: 'center' }, // 燈具裸露邊界（公尺）＋基準角
  theme: 'dark',
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const THICK = 0.015; // 材料厚度 15mm (公尺)

// 背景主題（深色 / 淺色）：僅影響背景與中性線條，語意化的射線/標示色不變
const THEMES = {
  dark:  { bg: '#0d1015', border: '#3a4248', eyeLine: 'rgba(255,255,255,0.15)' },
  light: { bg: '#eef1f4', border: '#9aa4ac', eyeLine: 'rgba(0,0,0,0.18)'      },
};
const theme = () => THEMES[S.theme] || THEMES.dark;

// 依燈槽幾何與側別計算光源座標（公尺）。距後牆與距底板皆夾在槽內。
function lightPos(cove, side, W) {
  const wd = clamp(cove.lightWallDist, 0, cove.depth);
  const pd = clamp(cove.lightPlateDist, 0, cove.height);
  const lx = side === 'L' ? wd : W - wd;
  const ly = cove.bottomY + pd;
  return { lx, ly };
}

// 燈具裸露邊界矩形（公尺）：以光源 (lx,ly) 為基準角，依水平/垂直基準設定延伸。
//   hAnchor: 'wall' 靠牆（向室內延伸）/ 'center' 置中 / 'interior' 靠室內（向牆延伸）
//   vAnchor: 'top' 上（向下延伸）/ 'center' 置中 / 'bottom' 下（向上延伸）
function glareBox(lx, ly, side) {
  const gW = Math.max(0, S.glare.width), gH = Math.max(0, S.glare.height);
  const inward = side === 'L' ? 1 : -1;   // 朝室內的 x 方向
  let x0, x1;
  if (S.glare.hAnchor === 'center') { x0 = lx - gW / 2; x1 = lx + gW / 2; }
  else {
    const dir = (S.glare.hAnchor === 'wall' ? inward : -inward);
    x0 = Math.min(lx, lx + dir * gW); x1 = Math.max(lx, lx + dir * gW);
  }
  let y0, y1;
  if (S.glare.vAnchor === 'top')         { y0 = ly - gH; y1 = ly; }
  else if (S.glare.vAnchor === 'bottom') { y0 = ly;      y1 = ly + gH; }
  else                                   { y0 = ly - gH / 2; y1 = ly + gH / 2; }
  return { x0, x1, y0, y1 };
}

// 光源顯示色：色相完全依色溫（與 kelvinToColor 一致），亮度僅影響
// 透明度與光暈大小，不改變色相。回傳 0–255 的 r8/g8/b8 與亮度因子 bf。
function lightDisplayColor() {
  const lc = kelvinToColor(S.cove.lightKelvin);
  const bf = clamp((S.cove.lightIntensity - 100) / (2000 - 100), 0, 1);
  return {
    r8: Math.round(lc.r * 255),
    g8: Math.round(lc.g * 255),
    b8: Math.round(lc.b * 255),
    bf,
  };
}

// ══ Canvas ════════════════════════════════════════════════════════
const canvas = document.getElementById('main-canvas');
const ctx    = canvas.getContext('2d');

function resizeCanvas() {
  const vp = document.getElementById('viewport');
  canvas.width  = vp.clientWidth  || (window.innerWidth - 280);
  canvas.height = vp.clientHeight || window.innerHeight;
  redraw();
}
window.addEventListener('resize', resizeCanvas);

// ══ 座標映射（含使用者縮放/平移）══════════════════════════════════
let _scale = 1, _ox = 0, _oy = 0;
let _zoom = 1, _panX = 0, _panY = 0;   // 使用者縮放倍率與平移量（螢幕像素）
const ZOOM_MIN = 1, ZOOM_MAX = 12;

function setupCoords(CW, CH) {
  const { W, H } = S.room;
  const pL = 58, pR = 44, pT = 38, pB = 52;
  const baseScale = Math.max(0, Math.min((CW - pL - pR) / W, (CH - pT - pB) / H));
  const baseOx = pL + ((CW - pL - pR) - baseScale * W) / 2;
  const baseOy = pT + ((CH - pT - pB) - baseScale * H) / 2 + baseScale * H;
  // 以畫布中心為基準套用 zoom，再加上平移
  const cx = CW / 2, cy = CH / 2;
  _scale = baseScale * _zoom;
  _ox = cx + (baseOx - cx) * _zoom + _panX;
  _oy = cy + (baseOy - cy) * _zoom + _panY;
}

const mx = (x) => _ox + x * _scale;
const my = (y) => _oy - y * _scale;

// 限制平移：室內矩形必須始終覆蓋畫布中心，避免拖到全空白而迷失
function clampPan() {
  const CW = canvas.width, CH = canvas.height;
  setupCoords(CW, CH);
  const left = mx(0), right = mx(S.room.W);
  const top = my(S.room.H), bottom = my(0);
  const cx = CW / 2, cy = CH / 2;
  if (right < cx) _panX += cx - right; else if (left > cx) _panX += cx - left;
  if (bottom < cy) _panY += cy - bottom; else if (top > cy) _panY += cy - top;
  setupCoords(CW, CH);
}

// 以螢幕點 (sx,sy) 為焦點縮放（焦點下的內容維持不動）
function zoomAt(sx, sy, factor) {
  const CW = canvas.width, CH = canvas.height;
  setupCoords(CW, CH);
  const wx = (sx - _ox) / _scale, wy = (_oy - sy) / _scale;
  _zoom = clamp(_zoom * factor, ZOOM_MIN, ZOOM_MAX);
  if (_zoom === ZOOM_MIN) { _panX = 0; _panY = 0; }
  setupCoords(CW, CH);
  _panX += sx - (_ox + wx * _scale);
  _panY += sy - (_oy - wy * _scale);
  clampPan();
  redraw();
}

function resetView() { _zoom = 1; _panX = 0; _panY = 0; redraw(); }

// ══ 場景結構 ══════════════════════════════════════════════════════
function buildScene() {
  const { W, H } = S.room;
  const c = S.cove;
  // 距天花板即燈槽高度：燈槽貼齊天花板，底板在天花板下方 height 處。
  const bottomY = H - c.height;
  const safeBH  = Math.min(c.baffleHeight, Math.max(0, c.height - 0.01));
  const coveData = {
    depth: c.depth, height: c.height, bottomY, thick: THICK,
    baffleEnabled: c.baffleEnabled, baffleHeight: safeBH,
    lightWallDist: c.lightWallDist, lightPlateDist: c.lightPlateDist,
  };
  return {
    W, H,
    leftCove:  S.sides.left  ? coveData : null,
    rightCove: S.sides.right ? coveData : null,
    refl: { ...S.refl },
    wallReflect: { ...S.wallReflect },
  };
}

// 牆面反射屬性：燈槽範圍內（底板以上的槽後牆）一律照常反射；
// 燈槽範圍外（底板以下的主牆面）依該側開關決定——關閉時 pass=true（光線完全穿透）。
function wallProps(scene, side, yi) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  const inCove = cove && yi >= cove.bottomY;
  if (inCove) return { r: scene.refl.wall, pass: false };
  const on = side === 'L' ? scene.wallReflect.left : scene.wallReflect.right;
  return on ? { r: scene.refl.wall, pass: false } : { r: 0, pass: true };
}

// 牆面薄帶/邊框的可見下緣 y：牆面只在 [回傳值, H] 之間繪製。
// 反射開啟 → 整面牆（0）；反射關閉 → 僅燈槽範圍內（bottomY），無燈槽則整面消失（H）。
function wallVisibleBottom(scene, side) {
  const on = side === 'L' ? scene.wallReflect.left : scene.wallReflect.right;
  if (on) return 0;
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  return cove ? cove.bottomY : scene.H;
}

// ══ 射線交叉計算 ══════════════════════════════════════════════════
/**
 * 找最近交點，回傳 { x, y, surf, r } 或 null
 * surf: 'ceiling' | 'floor' | 'wallL' | 'wallR' | 'plate' | 'baffle'
 */
function findHit(ox, oy, dx, dy, scene) {
  const { W, H, refl } = scene;
  let tMin = Infinity, surf = null, r = 1, horiz = true, pass = false;

  const try_ = (t, s, rv, h, p = false) => {
    if (t > 1e-5 && t < tMin) { tMin = t; surf = s; r = rv; horiz = h; pass = p; }
  };

  // 室內四面
  if (dy > 0) try_((H - oy) / dy, 'ceiling', refl.ceiling, true);
  if (dy < 0) try_(-oy / dy,       'floor',   refl.floor, true);
  if (dx < 0) {
    const t = -ox / dx, yi = oy + dy * t;
    if (yi >= 0 && yi <= H) { const w = wallProps(scene, 'L', yi); try_(t, 'wallL', w.r, false, w.pass); }
  }
  if (dx > 0) {
    const t = (W - ox) / dx, yi = oy + dy * t;
    if (yi >= 0 && yi <= H) { const w = wallProps(scene, 'R', yi); try_(t, 'wallR', w.r, false, w.pass); }
  }

  // 燈槽結構（左右各一）— 考慮材料厚度
  const addCove = (cove, side) => {
    if (!cove) return;
    const { depth, bottomY, baffleEnabled, baffleHeight, thick } = cove;
    const T = thick;

    // ── 底板 box: [plateL, plateR] × [plateBot, plateTop] ──
    const plateTop = bottomY;
    const plateBot = bottomY - T;
    const plateL = side === 'L' ? 0 : W - depth;
    const plateR = side === 'L' ? depth : W;

    // 底板上面 (水平)
    if (dy < 0 && oy > plateTop) {
      const t = (plateTop - oy) / dy, xi = ox + dx * t;
      if (xi >= plateL && xi <= plateR) try_(t, 'plate', 0.25, true);
    }
    // 底板下面 (水平)
    if (dy > 0 && oy < plateBot) {
      const t = (plateBot - oy) / dy, xi = ox + dx * t;
      if (xi >= plateL && xi <= plateR) try_(t, 'plate', 0.25, true);
    }
    // 底板前緣 (垂直面)
    if (dx !== 0) {
      const frontX = side === 'L' ? depth : W - depth;
      const t = (frontX - ox) / dx;
      if (t > 1e-5) {
        const yi = oy + dy * t;
        if (yi >= plateBot && yi <= plateTop) try_(t, 'plate', 0.25, false);
      }
    }

    // ── 擋板 box: [bL, bR] × [bBot, bTop] ──
    if (baffleEnabled && baffleHeight > 0.005) {
      const bCenterX = side === 'L' ? depth : W - depth;
      const bL = bCenterX - T / 2;
      const bR = bCenterX + T / 2;
      const bBot = bottomY;
      const bTop = bottomY + baffleHeight;

      // 擋板左面 (垂直)
      if (dx !== 0) {
        const t = (bL - ox) / dx;
        if (t > 1e-5) {
          const yi = oy + dy * t;
          if (yi >= bBot && yi <= bTop) try_(t, 'baffle', 0.2, false);
        }
      }
      // 擋板右面 (垂直)
      if (dx !== 0) {
        const t = (bR - ox) / dx;
        if (t > 1e-5) {
          const yi = oy + dy * t;
          if (yi >= bBot && yi <= bTop) try_(t, 'baffle', 0.2, false);
        }
      }
      // 擋板頂面 (水平)
      if (dy !== 0) {
        const t = (bTop - oy) / dy;
        if (t > 1e-5) {
          const xi = ox + dx * t;
          if (xi >= bL && xi <= bR) try_(t, 'baffle', 0.2, true);
        }
      }
    }
  };

  addCove(scene.leftCove,  'L');
  addCove(scene.rightCove, 'R');

  if (!surf) return null;
  return { x: ox + dx * tMin, y: oy + dy * tMin, surf, r, horiz, pass };
}

// ══ 射線繪製 ══════════════════════════════════════════════════════
function drawRays(scene, side) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  if (!cove) return;

  const { W } = scene;
  const { lx: lightX, ly: lightY } = lightPos(cove, side, W);

  // 發光範圍：不做幾何裁切，由射線與擋板/底板的碰撞自然決定遮蔽，
  // 因此自體旋轉可朝任意方向（含水平線以下）。
  const raw  = S.cove.rotationAngle;
  const half = S.cove.emissionAngle / 2;
  const effMin = raw - half;
  const effMax = raw + half;

  const n  = Math.max(2, S.ray.density);
  // 射線顏色隨色溫（色相）與亮度（明度/不透明度）變化，並依反光係數逐次衰減。
  const { r8, g8, b8, bf } = lightDisplayColor();
  const baseAlpha = Math.min(0.78, 0.18 + bf * 0.60);

  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const θ   = n === 1 ? (effMin + effMax) / 2 : effMin + i * (effMax - effMin) / (n - 1);
    const rad = θ * Math.PI / 180;
    // 左側往右（+x）；右側往左（-x）
    const sign = side === 'L' ? 1 : -1;
    let cdx = sign * Math.sin(rad), cdy = Math.cos(rad);
    let cox = lightX, coy = lightY, alpha = baseAlpha;

    for (let b = 0; b <= S.ray.bounces; b++) {
      const hit = findHit(cox, coy, cdx, cdy, scene);
      if (!hit) break;

      // 槽外牆面反射關閉 → 光線完全穿透牆面、沿原方向射出室外後結束
      if (hit.pass) {
        const far = (scene.W + scene.H) * 3;
        ctx.beginPath();
        ctx.moveTo(mx(cox), my(coy));
        ctx.lineTo(mx(cox + cdx * far), my(coy + cdy * far));
        ctx.strokeStyle = `rgba(${r8},${g8},${b8},${alpha.toFixed(3)})`;
        ctx.stroke();
        break;
      }

      ctx.beginPath();
      ctx.moveTo(mx(cox), my(coy));
      ctx.lineTo(mx(hit.x), my(hit.y));
      ctx.strokeStyle = `rgba(${r8},${g8},${b8},${alpha.toFixed(3)})`;
      ctx.stroke();

      if (b === S.ray.bounces) break;
      alpha *= hit.r;          // 每次反射依材質反光係數衰減
      if (alpha < 0.012) break;

      // 反射方向（依碰撞面方向決定）
      if (hit.horiz) {
        cdy = -cdy; coy = hit.y + cdy * 1e-4; cox = hit.x;
      } else {
        cdx = -cdx; cox = hit.x + cdx * 1e-4; coy = hit.y;
      }
    }
  }
}

// ══ 燈槽幾何繪製 ══════════════════════════════════════════════════
function drawCoveGeo(scene, side) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  if (!cove) return;
  const { W } = scene;
  const { depth, bottomY, baffleEnabled, baffleHeight, thick } = cove;
  const T = thick;
  const pt = Math.max(2, T * _scale); // 板厚像素，最少 2px

  ctx.fillStyle = '#c0c0c0';
  if (side === 'L') {
    // 底板（有厚度的矩形）
    ctx.fillRect(mx(0), my(bottomY), depth * _scale, pt);
    // 擋板（有厚度的矩形）
    if (baffleEnabled && baffleHeight > 0.005)
      ctx.fillRect(mx(depth - T / 2), my(bottomY + baffleHeight), Math.max(2, T * _scale), baffleHeight * _scale);
  } else {
    // 底板
    ctx.fillRect(mx(W - depth), my(bottomY), depth * _scale, pt);
    // 擋板
    if (baffleEnabled && baffleHeight > 0.005)
      ctx.fillRect(mx(W - depth - T / 2), my(bottomY + baffleHeight), Math.max(2, T * _scale), baffleHeight * _scale);
  }
}

// ── 遮光截止角虛線 ──────────────────────────────────────────────
function drawCriticalAngle(scene, side) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  if (!cove || !cove.baffleEnabled || cove.baffleHeight <= 0.005) return;
  const { W, H } = scene;
  const { depth, bottomY, baffleHeight, thick } = cove;
  const { lx: lightX, ly: lightY } = lightPos(cove, side, W);
  const T = thick;
  // 遮光臨界點取擋板槽側頂角（材料厚度偏移）
  const baffleX = side === 'L' ? depth - T / 2 : W - depth + T / 2;
  const baffleTop = bottomY + baffleHeight;
  if (lightY >= baffleTop) return;

  const ddx = baffleX - lightX, ddy = baffleTop - lightY;
  const len  = Math.sqrt(ddx * ddx + ddy * ddy);
  if (len < 1e-6) return;
  const nx = ddx / len, ny = ddy / len;
  const tCeil = (H - baffleTop) / ny;
  const xEnd  = baffleX + nx * tCeil;

  ctx.save();
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = `rgba(255,170,0,0.45)`;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(mx(lightX), my(lightY));
  ctx.lineTo(mx(baffleX), my(baffleTop));
  ctx.lineTo(mx(xEnd), my(H));
  ctx.stroke();
  ctx.restore();
}

// ── 光源光暈 ────────────────────────────────────────────────────
function drawLightDot(scene, side) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  if (!cove) return;
  const { W } = scene;
  const { lx, ly } = lightPos(cove, side, W);
  // 光暈顏色隨色溫/亮度，光暈大小亦隨亮度增大。
  const { r8, g8, b8, bf } = lightDisplayColor();
  const glowR = Math.min(34, _scale * (0.16 + 0.20 * bf));
  const grd = ctx.createRadialGradient(mx(lx), my(ly), 0, mx(lx), my(ly), glowR);
  grd.addColorStop(0,    `rgba(${r8},${g8},${b8},1)`);
  grd.addColorStop(0.5,  `rgba(${r8},${g8},${b8},0.28)`);
  grd.addColorStop(1,    `rgba(${r8},${g8},${b8},0)`);
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.arc(mx(lx), my(ly), glowR, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = `rgb(${r8},${g8},${b8})`;
  ctx.beginPath(); ctx.arc(mx(lx), my(ly), 3.5, 0, Math.PI * 2); ctx.fill();
}

// ── 燈具裸露邊界框（眩光判定範圍）─────────────────────────────────
function drawGlareBox(scene, side) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  if (!cove) return;
  const gW = Math.max(0, S.glare.width), gH = Math.max(0, S.glare.height);
  if (gW <= 0 && gH <= 0) return;
  const { W } = scene;
  const { lx, ly } = lightPos(cove, side, W);
  const { x0, x1, y0, y1 } = glareBox(lx, ly, side);
  const { r8, g8, b8 } = lightDisplayColor();
  const px = mx(x0), py = my(y1), pw = (x1 - x0) * _scale, ph = (y1 - y0) * _scale;
  ctx.save();
  ctx.fillStyle = `rgba(${r8},${g8},${b8},0.16)`;
  ctx.fillRect(px, py, pw, ph);
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = `rgba(${r8},${g8},${b8},0.7)`;
  ctx.strokeRect(px, py, pw, ph);
  ctx.restore();
}

// ══ 眩光分析 ══════════════════════════════════════════════════════
/**
 * 分析單側燈槽在指定眼高的眩光狀況。
 * 遮擋邊緣 = 擋板頂端（有啟用擋板時）或底板前緣（無擋板時，下檔板仍遮視角）。
 * 透過光源與該邊緣的連線、再與眼高線求交點，得到眩光/安全分界 x。
 * 回傳的 baffleTop 欄位實為「遮擋邊緣高度」(edgeY)。
 * status:
 *   'shielded'  完全遮蔽（室內任何距離都看不到光源）
 *   'allGlare'  全區可見
 *   'safeNear'  近牆安全、超過 xGraze 後可見光源
 *   'safeFar'   遠處安全、未達 xGraze 時可見光源
 */
// 針對單一光源點計算遮蔽狀態（眩光分析核心）
function analyzePoint(px, py, baffleX, edgeY, eyeH) {
  const eAbove = eyeH > edgeY;
  const lAbove = py   > edgeY;
  if (!eAbove && !lAbove) return { status: 'shielded', xGraze: null };
  if (eAbove && lAbove)   return { status: 'allGlare', xGraze: null };
  // 光源恰好齊平遮擋邊緣：掠射線水平 → 全區可見
  if (Math.abs(edgeY - py) < 1e-6) return { status: 'allGlare', xGraze: null };
  const t = (eyeH - py) / (edgeY - py);
  return { status: lAbove ? 'safeNear' : 'safeFar', xGraze: px + t * (baffleX - px) };
}

function analyzeSide(cove, side, W, eyeH) {
  const { depth, bottomY, baffleEnabled, baffleHeight, thick } = cove;
  const { lx: lightX, ly: lightY } = lightPos(cove, side, W);
  const T = thick;

  // 遮擋邊緣：有擋板取擋板槽側頂角，否則取底板前緣。（含材料厚度偏移）
  const hasBaffle = baffleEnabled && baffleHeight > 0.005;
  const baffleX = hasBaffle
    ? (side === 'L' ? depth - T / 2 : W - depth + T / 2)
    : (side === 'L' ? depth : W - depth);
  const edgeY = hasBaffle ? bottomY + baffleHeight : bottomY;

  // 燈具裸露邊界：矩形範圍，基準角（光源所在角）可設定。
  // 把光源視為一個矩形範圍，眩光取「最易被看見」的角（眩光區最大）作為判定。
  const box = glareBox(lightX, lightY, side);
  const corners = [
    { x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 },
    { x: box.x0, y: box.y1 }, { x: box.x1, y: box.y1 },
  ];
  // allGlare / shielded 時的繪圖代表點取矩形中心
  const rep = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };

  let anyAll = false, best = null, bestCorner = null;
  for (const c of corners) {
    const r = analyzePoint(c.x, c.y, baffleX, edgeY, eyeH);
    if (r.status === 'allGlare') { anyAll = true; continue; }
    if (r.status === 'shielded') continue;
    // 取「眩光區最大（最裸露）」的臨界角。眩光條件依 side/status 不同，
    // 較小 xGraze 較裸露者：左側 safeNear、右側 safeFar；其餘較大 xGraze 較裸露。
    if (!best) { best = r; bestCorner = c; continue; }
    const smallerWorse = (side === 'L' && r.status === 'safeNear') ||
                         (side === 'R' && r.status === 'safeFar');
    const worse = smallerWorse ? (r.xGraze < best.xGraze) : (r.xGraze > best.xGraze);
    if (worse) { best = r; bestCorner = c; }
  }

  if (anyAll)
    return { status: 'allGlare', lightX: rep.x, lightY: rep.y, baffleX, baffleTop: edgeY, xGraze: null, box };
  if (!best)
    return { status: 'shielded', lightX: rep.x, lightY: rep.y, baffleX, baffleTop: edgeY, xGraze: null, box };
  return { status: best.status, lightX: bestCorner.x, lightY: bestCorner.y, baffleX, baffleTop: edgeY, xGraze: best.xGraze, box };
}

// ══ 眼睛視角 / 安全距離 ═══════════════════════════════════════════
function drawEye(scene) {
  if (!S.eye.show) return;
  const { W } = scene;
  const eyeX = S.eye.xRatio * W;
  const eyeH = S.eye.height;
  const ex = mx(eyeX), ey = my(eyeH);

  // 眼高水平虛線
  ctx.save();
  ctx.setLineDash([5, 6]);
  ctx.strokeStyle = theme().eyeLine;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(mx(0), ey); ctx.lineTo(mx(W), ey); ctx.stroke();
  ctx.restore();

  const infos = [];

  for (const [cove, side] of [[scene.leftCove, 'L'], [scene.rightCove, 'R']]) {
    if (!cove) continue;
    const a   = analyzeSide(cove, side, W, eyeH);
    const tag = side === 'L' ? '左側' : '右側';

    // 觀察者目前位置是否直視光源
    let seen = false;
    if      (a.status === 'allGlare') seen = true;
    else if (a.status === 'shielded') seen = false;
    else if (a.status === 'safeNear') seen = side === 'L' ? eyeX > a.xGraze : eyeX < a.xGraze;
    else if (a.status === 'safeFar')  seen = side === 'L' ? eyeX < a.xGraze : eyeX > a.xGraze;

    // 觀察者視線
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = seen ? 'rgba(255,70,70,0.7)' : 'rgba(60,200,60,0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(mx(a.lightX), my(a.lightY));
    ctx.stroke();
    ctx.restore();

    // 安全距離臨界線（光源 → 擋板頂端 → 眼高交點）與刻度
    if (a.xGraze !== null && a.xGraze >= 0 && a.xGraze <= W) {
      const gx = mx(a.xGraze);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(255,170,0,0.6)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(mx(a.lightX), my(a.lightY));
      ctx.lineTo(mx(a.baffleX), my(a.baffleTop));
      ctx.lineTo(gx, ey);
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,170,0,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(gx, ey - 8); ctx.lineTo(gx, ey + 8); ctx.stroke();
      ctx.fillStyle = 'rgba(255,190,60,0.95)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const distMM = Math.round((side === 'L' ? a.xGraze : W - a.xGraze) * 1000);
      ctx.fillText(distMM + ' mm', gx, ey - 12);
      ctx.textAlign = 'left';
    }

    // 文字結論 — 安全距離不考慮室寬，直接回報臨界距離。
    let label, color;
    if (a.status === 'shielded') {
      label = `${tag}：完全遮蔽 ✓`; color = 'rgba(90,220,90,0.95)';
    } else if (a.status === 'allGlare') {
      label = `${tag}：全區可見光源 ⚠`; color = 'rgba(255,90,90,0.95)';
    } else {
      // 距牆距離（公尺）；不夾在 [0, W] 內，超出室寬仍照實回報。
      const dist = side === 'L' ? a.xGraze : W - a.xGraze;
      const distTxt = `${Math.round(dist * 1000)} mm`;
      if (a.status === 'safeNear') {
        // 近牆安全、超過此距離後產生眩光 → 最遠安全距離
        label = `${tag}：最遠安全距離 ${distTxt}（更遠眩光）`;
      } else { // safeFar：近處眩光、超過此距離才安全 → 最近安全距離
        label = `${tag}：最近安全距離 ${distTxt}（更近眩光）`;
      }
      color = 'rgba(255,190,60,0.95)';
    }
    infos.push({ label, color });
  }

  // 觀察者眼睛符號
  ctx.fillStyle = 'rgba(80,200,255,0.9)';
  ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI * 2); ctx.stroke();

  // 眼高標籤
  ctx.fillStyle = 'rgba(140,210,255,0.65)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`眼高 ${Math.round(eyeH * 1000)} mm`, mx(0) - 5, ey + 4);
  ctx.textAlign = 'left';

  // 安全距離結論（左上角）
  ctx.font = '12px system-ui, sans-serif';
  let ty = 20;
  for (const info of infos) {
    ctx.fillStyle = info.color;
    ctx.fillText(info.label, 12, ty);
    ty += 18;
  }
}

// ══ 尺寸標注 ══════════════════════════════════════════════════════
function drawDims(scene) {
  const { W, H } = scene;
  ctx.fillStyle = 'rgba(130,145,155,0.75)';
  ctx.font = '11px system-ui, sans-serif';

  // 室寬（底部）
  ctx.textAlign = 'center';
  ctx.fillText(`W = ${Math.round(W * 1000)} mm`, (mx(0) + mx(W)) / 2, my(0) + 32);

  // 室高（左側垂直）
  ctx.save();
  ctx.translate(mx(0) - 38, (my(0) + my(H)) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText(`H = ${Math.round(H * 1000)} mm`, 0, 0);
  ctx.restore();

  ctx.textAlign = 'left';
}

// ══ 主繪圖函數 ════════════════════════════════════════════════════
function redraw() {
  const CW = canvas.width, CH = canvas.height;
  if (CW <= 0 || CH <= 0) return;

  setupCoords(CW, CH);
  ctx.clearRect(0, 0, CW, CH);

  const scene = buildScene();
  const { W, H } = scene;

  // 背景（依主題）
  ctx.fillStyle = theme().bg;
  ctx.fillRect(0, 0, CW, CH);

  // 表面薄帶（一律畫在室外側，使反射發生在材料的室內表面、不被射線穿透）
  const st = Math.max(3, 0.022 * _scale);
  ctx.fillStyle = 'rgba(215,210,195,0.65)';
  ctx.fillRect(mx(0), my(H) - st, W * _scale, st);         // 天花板（畫在 y=H 之上）
  ctx.fillStyle = 'rgba(150,130,100,0.55)';
  ctx.fillRect(mx(0), my(0), W * _scale, st);              // 地板（畫在 y=0 之下）
  // 牆面薄帶：反射關閉時，燈槽範圍外的牆面消失（只保留燈槽範圍內）
  const lWallBot = wallVisibleBottom(scene, 'L');
  const rWallBot = wallVisibleBottom(scene, 'R');
  ctx.fillStyle = 'rgba(185,185,185,0.45)';
  if (lWallBot < H) ctx.fillRect(mx(0) - st, my(H), st, (H - lWallBot) * _scale);  // 左牆
  if (rWallBot < H) ctx.fillRect(mx(W),      my(H), st, (H - rWallBot) * _scale);  // 右牆

  // 室內邊框（牆面消失處不畫邊線）
  ctx.strokeStyle = theme().border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mx(0), my(H)); ctx.lineTo(mx(W), my(H));     // 天花板
  ctx.moveTo(mx(0), my(0)); ctx.lineTo(mx(W), my(0));     // 地板
  if (lWallBot < H) { ctx.moveTo(mx(0), my(H)); ctx.lineTo(mx(0), my(lWallBot)); }  // 左牆
  if (rWallBot < H) { ctx.moveTo(mx(W), my(H)); ctx.lineTo(mx(W), my(rWallBot)); }  // 右牆
  ctx.stroke();

  // 燈槽幾何
  drawCoveGeo(scene, 'L');
  drawCoveGeo(scene, 'R');

  // 遮光截止角（在射線前面，作為背景參考）
  drawCriticalAngle(scene, 'L');
  drawCriticalAngle(scene, 'R');

  // 射線（最主要的視覺元素）
  drawRays(scene, 'L');
  drawRays(scene, 'R');

  // 燈具裸露邊界框（眩光判定範圍）
  drawGlareBox(scene, 'L');
  drawGlareBox(scene, 'R');

  // 光源光暈（蓋在射線之上）
  drawLightDot(scene, 'L');
  drawLightDot(scene, 'R');

  // 眼睛視角
  drawEye(scene);

  // 尺寸標注
  drawDims(scene);
}

// ══ UI Bindings ═══════════════════════════════════════════════════
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// 將數值夾在滑桿範圍內並對齊 step
function clampToSlider(el, v) {
  const min = parseFloat(el.min), max = parseFloat(el.max), step = parseFloat(el.step);
  v = Math.max(min, Math.min(max, v));
  if (!isNaN(step) && step > 0) {
    v = min + Math.round((v - min) / step) * step;
    v = Math.max(min, Math.min(max, v));
  }
  return v;
}

// 點擊數值文字 → 變成可輸入欄位，Enter/失焦套用、Esc 取消
function startValueEdit(el, vl, apply) {
  if (vl.querySelector('input')) return;
  const prev = vl.textContent;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'value-edit';
  inp.value = String(parseFloat(el.value));
  vl.textContent = '';
  vl.appendChild(inp);
  inp.focus();
  inp.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const v = parseFloat(inp.value);
    if (commit && !isNaN(v)) apply(clampToSlider(el, v), true);
    else vl.textContent = prev;
  };
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')      { e.preventDefault(); finish(true);  }
    else if (e.key === 'Escape'){ e.preventDefault(); finish(false); }
  });
}

function bindSlider(id, valId, unit, decimals, setter) {
  const el = document.getElementById(id);
  const vl = document.getElementById(valId);
  if (!el || !vl) return;

  const fmt = (v) => v.toFixed(decimals) + (unit ? ' ' + unit : '');
  const apply = (v, updateSlider) => {
    if (updateSlider) el.value = v;
    vl.textContent = fmt(v);
    setter(v);
    redraw();
  };

  el.addEventListener('input', () => apply(parseFloat(el.value), false));

  vl.classList.add('editable');
  vl.title = '點擊以輸入數值';
  vl.addEventListener('click', () => startValueEdit(el, vl, apply));
}

// 空間（長度 mm → 內部公尺）
bindSlider('room-width',  'room-width-val',  'mm', 0, v => { S.room.W = v / 1000; });
bindSlider('room-height', 'room-height-val', 'mm', 0, v => { S.room.H = v / 1000; });
bindSlider('refl-ceiling', 'refl-ceiling-val', '', 2, v => { S.refl.ceiling = v; });
bindSlider('refl-wall',    'refl-wall-val',    '', 2, v => { S.refl.wall    = v; });
bindSlider('refl-floor',   'refl-floor-val',   '', 2, v => { S.refl.floor   = v; });
document.getElementById('wall-refl-left').addEventListener('change',  e => { S.wallReflect.left  = e.target.checked; redraw(); });
document.getElementById('wall-refl-right').addEventListener('change', e => { S.wallReflect.right = e.target.checked; redraw(); });

// 燈槽（光源相關）
document.getElementById('side-left').addEventListener('change',  e => { S.sides.left  = e.target.checked; redraw(); });
document.getElementById('side-right').addEventListener('change', e => { S.sides.right = e.target.checked; redraw(); });
bindSlider('cove-depth',  'cove-depth-val',  'mm', 0, v => { S.cove.depth  = v / 1000; });
bindSlider('cove-height', 'cove-height-val', 'mm', 0, v => { S.cove.height = v / 1000; });
document.getElementById('baffle-enabled').addEventListener('change', e => { S.cove.baffleEnabled = e.target.checked; redraw(); });
bindSlider('baffle-height',     'baffle-height-val',     'mm', 0, v => { S.cove.baffleHeight   = v / 1000; });
bindSlider('light-wall-dist',   'light-wall-dist-val',   'mm', 0, v => { S.cove.lightWallDist  = v / 1000; });
bindSlider('light-plate-dist',  'light-plate-dist-val',  'mm', 0, v => { S.cove.lightPlateDist = v / 1000; });
bindSlider('emission-angle', 'emission-angle-val', '°', 0, v => { S.cove.emissionAngle = v; });
bindSlider('rotation-angle', 'rotation-angle-val', '°', 0, v => { S.cove.rotationAngle = v; });
bindSlider('light-kelvin',   'light-kelvin-val',   'K', 0, v => { S.cove.lightKelvin   = v; });
bindSlider('light-intensity', 'light-intensity-val', '', 0, v => { S.cove.lightIntensity = v; });
bindSlider('ray-density',  'ray-density-val',  '條', 0, v => { S.ray.density  = v; });
bindSlider('ray-bounces',  'ray-bounces-val',  '次', 0, v => { S.ray.bounces  = v; });

// 視角
document.getElementById('theme-light').addEventListener('change', e => { S.theme = e.target.checked ? 'light' : 'dark'; redraw(); });
document.getElementById('eye-show').addEventListener('change', e => { S.eye.show = e.target.checked; redraw(); });
bindSlider('eye-height', 'eye-height-val', 'mm', 0, v => { S.eye.height = v / 1000; });
bindSlider('eye-x',      'eye-x-val',      '', 2,  v => { S.eye.xRatio = v; });
bindSlider('glare-width',  'glare-width-val',  'mm', 0, v => { S.glare.width  = v / 1000; });
bindSlider('glare-height', 'glare-height-val', 'mm', 0, v => { S.glare.height = v / 1000; });
document.getElementById('glare-hanchor').addEventListener('change', e => { S.glare.hAnchor = e.target.value; redraw(); });
document.getElementById('glare-vanchor').addEventListener('change', e => { S.glare.vAnchor = e.target.value; redraw(); });

// ══ 縮放 / 平移互動 ═══════════════════════════════════════════════
canvas.style.cursor = 'grab';
const _vpScale = () => { const r = canvas.getBoundingClientRect(); return canvas.width / (r.width || 1); };

// 滾輪縮放（以游標為焦點）
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const k = canvas.width / (rect.width || 1);
  const sx = (e.clientX - rect.left) * k, sy = (e.clientY - rect.top) * k;
  zoomAt(sx, sy, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

// 滑鼠拖曳平移
let _dragging = false, _lastX = 0, _lastY = 0;
canvas.addEventListener('mousedown', (e) => {
  _dragging = true; _lastX = e.clientX; _lastY = e.clientY; canvas.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', (e) => {
  if (!_dragging) return;
  const k = _vpScale();
  _panX += (e.clientX - _lastX) * k; _panY += (e.clientY - _lastY) * k;
  _lastX = e.clientX; _lastY = e.clientY;
  clampPan(); redraw();
});
window.addEventListener('mouseup', () => { _dragging = false; canvas.style.cursor = 'grab'; });

// 觸控：單指平移、雙指縮放
let _touchMode = null, _tLastX = 0, _tLastY = 0, _tStartDist = 0, _tStartZoom = 1;
const _touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    _touchMode = 'pan'; _tLastX = e.touches[0].clientX; _tLastY = e.touches[0].clientY;
  } else if (e.touches.length === 2) {
    _touchMode = 'pinch'; _tStartDist = _touchDist(e.touches) || 1; _tStartZoom = _zoom;
  }
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const k = canvas.width / (rect.width || 1);
  if (_touchMode === 'pan' && e.touches.length === 1) {
    _panX += (e.touches[0].clientX - _tLastX) * k;
    _panY += (e.touches[0].clientY - _tLastY) * k;
    _tLastX = e.touches[0].clientX; _tLastY = e.touches[0].clientY;
    clampPan(); redraw();
  } else if (_touchMode === 'pinch' && e.touches.length === 2) {
    const d = _touchDist(e.touches);
    const mpx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const mpy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const sx = (mpx - rect.left) * k, sy = (mpy - rect.top) * k;
    const target = clamp(_tStartZoom * (d / _tStartDist), ZOOM_MIN, ZOOM_MAX);
    zoomAt(sx, sy, target / _zoom);
  }
}, { passive: false });
canvas.addEventListener('touchend', (e) => { if (e.touches.length === 0) _touchMode = null; });

// 縮放按鈕
const _vpCenter = () => ({ x: canvas.width / 2, y: canvas.height / 2 });
document.getElementById('zoom-in').addEventListener('click',    () => { const c = _vpCenter(); zoomAt(c.x, c.y, 1.25); });
document.getElementById('zoom-out').addEventListener('click',   () => { const c = _vpCenter(); zoomAt(c.x, c.y, 0.8);  });
document.getElementById('zoom-reset').addEventListener('click', resetView);

// ══ 手機版：底部設定面板收合 ═════════════════════════════════════
const _panel = document.getElementById('panel');
const _mqMobile = window.matchMedia('(max-width: 820px)');
document.getElementById('panel-header').addEventListener('click', () => {
  if (_mqMobile.matches) _panel.classList.toggle('collapsed');
});
function applyMobileDefault() {
  // 進入手機版預設收合，讓使用者先看到模擬畫面
  _panel.classList.toggle('collapsed', _mqMobile.matches);
}
_mqMobile.addEventListener('change', () => { applyMobileDefault(); resizeCanvas(); });
applyMobileDefault();

// ══ 初始化 ════════════════════════════════════════════════════════
resizeCanvas();
