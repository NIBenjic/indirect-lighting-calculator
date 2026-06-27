// geometry.js — 燈槽幾何／範本建構（純函式：form/範本 → 局部剖面幾何）。無 DOM、無全域狀態。
import { clamp, THICK } from './core.js';

const WALL_EPS = 1e-4;

// 圓弧 → 切線段（chord-error≈3mm 控制段數，夾 4..64）
export function arcPoints(arc) {
  const R = Math.max(1e-4, arc.radius);
  const sweep = Math.abs(arc.sweepDeg) * Math.PI / 180;
  const e = 0.003;
  const dThetaMax = R > e ? 2 * Math.acos(Math.max(-1, 1 - e / R)) : Math.PI;
  const N = Math.max(4, Math.min(64, Math.ceil(sweep / dThetaMax) || 4));
  const a0 = arc.startDeg * Math.PI / 180, dir = arc.sweepDeg >= 0 ? 1 : -1;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const phi = a0 + dir * sweep * (i / N);
    pts.push({ u: arc.center.u + R * Math.cos(phi), d: arc.center.d + R * Math.sin(phi) });
  }
  return pts;
}
// 弧線兩端點（局部座標）：角度 startDeg 與 startDeg+sweepDeg
export function arcEndpoints(arc) {
  return [arc.startDeg, arc.startDeg + arc.sweepDeg].map(deg => {
    const r = deg * Math.PI / 180;
    return { u: arc.center.u + arc.radius * Math.cos(r), d: arc.center.d + arc.radius * Math.sin(r) };
  });
}
// 取元件中心線點列（局部座標）
export function elementCenterline(el) {
  return el.path.kind === 'arc' ? arcPoints(el.path) : el.path.points.map(p => ({ u: p.u, d: p.d }));
}
// 厚片：中心線 ±thickness/2 → 封閉外輪廓 + 邊界物理面
export function ribbonFromCenter(pts, thickness) {
  const h = (thickness || THICK) / 2;
  const left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tu = b.u - a.u, td = b.d - a.d; const L = Math.hypot(tu, td) || 1; tu /= L; td /= L;
    const nu = -td, nd = tu;
    left.push({ u: pts[i].u + nu * h, d: pts[i].d + nd * h });
    right.push({ u: pts[i].u - nu * h, d: pts[i].d - nd * h });
  }
  const faces = [];
  for (let i = 0; i < pts.length - 1; i++) {
    faces.push({ a: left[i], b: left[i + 1] });
    faces.push({ a: right[i], b: right[i + 1] });
  }
  const last = pts.length - 1;
  faces.push({ a: left[0], b: right[0] });
  faces.push({ a: left[last], b: right[last] });
  return { outline: left.concat(right.slice().reverse()), faces };
}
// 編譯 form → local 幾何 { fillLoops, faces, light, shield, bottomD }
// faces 每段帶 { a, b, r(反光), transparency(透光), surf }；貼牆面（u≈0）由牆面處理、不計入。
export function compileForm(form, fixtureOverride) {
  const fillLoops = [], faces = [], outlines = [];
  let maxD = 0, wallMaxD = 0, maxU = 0;
  for (const el of (form.elements || [])) {
    if (el.hidden) continue;
    let outline, rawFaces;
    if (el.kind === 'polygon') {
      const pts = elementCenterline(el);
      outline = pts;
      rawFaces = pts.map((p, i) => ({ a: p, b: pts[(i + 1) % pts.length] }));
    } else { // panel
      const r = ribbonFromCenter(elementCenterline(el), el.thickness);
      outline = r.outline; rawFaces = r.faces;
    }
    const refl = clamp(el.reflect != null ? el.reflect : 0.25, 0, 1);
    const tau  = clamp(el.transparency != null ? el.transparency : 0, 0, 1);
    fillLoops.push({ id: el.id, fill: '#c0c0c0', transparency: tau, pts: outline });
    for (const f of rawFaces) {
      if (Math.abs(f.a.u) < WALL_EPS && Math.abs(f.b.u) < WALL_EPS) continue; // 貼牆面由牆面處理
      faces.push({ a: f.a, b: f.b, r: refl, transparency: tau, surf: el.id || 'panel' });
    }
    for (const p of outline) {
      if (p.d > maxD) maxD = p.d;
      if (p.u > maxU) maxU = p.u;
      if (p.u < WALL_EPS && p.d > wallMaxD) wallMaxD = p.d; // 貼牆材料的最低延伸
    }
    outlines.push({ outline, opaque: tau === 0 });
  }
  // 遮擋候選：取「離牆夠遠（非貼牆背板）」的不透光邊角；getShieldPoint 再選最高者。
  const uMin = Math.max(0.02, 0.12 * maxU);
  const shieldCands = [];
  for (const o of outlines) if (o.opaque) for (const p of o.outline) if (p.u >= uMin) shieldCands.push(p);
  const fixture = fixtureOverride || form.fixture || { u: 0.09, d: 0.20 };   // 作用中光源位置（光源分頁）
  const shield = { candidates: shieldCands.length ? shieldCands : [fixture],
                   taggedIdx: 0, hasCutoff: shieldCands.length > 0, silhouette: true };
  // 牆面「槽內/槽外」分界：優先取貼牆材料的延伸（wallMaxD），無貼牆材料才退回整體最低點。
  const bottomD = wallMaxD > 0 ? wallMaxD : maxD;
  return { fillLoops, faces, light: { u: fixture.u, d: fixture.d }, shield, bottomD };
}

// ── 範本：由幾何參數產生可編輯的 form ──────────────────────────────
// 光源掛點（局部座標）
export function coveLight(g) {
  return { u: clamp(g.lightWallDist, 0, g.depth), d: g.height - clamp(g.lightPlateDist, 0, g.height) };
}
// 面板建構器
export function panel(id, name, points, reflect, opts) {
  return { id, name, kind: 'panel', thickness: (opts && opts.thickness) || THICK,
           reflect, transparency: (opts && opts.transparency) || 0, materialName: (opts && opts.materialName) || '',
           path: { kind: 'polyline', points } };
}
export const TEMPLATES = {
  // 經典：底板（中心線在 height+T/2）＋選用前擋板（前緣 u=depth）
  classic(g) {
    const T = THICK, { depth, height } = g;
    const safeBH = Math.min(g.baffleHeight, Math.max(0, height - 0.01));
    const els = [ panel('plate', '底板', [ {u:0, d:height + T/2}, {u:depth, d:height + T/2} ], 0.25) ];
    if (g.baffleEnabled && safeBH > 0.005)
      els.push(panel('baffle', '前擋板', [ {u:depth, d:height}, {u:depth, d:height - safeBH} ], 0.2));
    return { schema: 'cove-form@2', units: 'm', elements: els, fixture: coveLight(g), joints: [] };
  },
  // U 型槽：經典 + 貼牆背板（中心線 u=T/2）
  uChannel(g) {
    const T = THICK, { height } = g;
    const safeBH = Math.min(g.baffleHeight, Math.max(0, height - 0.01));
    const bh = safeBH > 0.005 ? safeBH : Math.min(0.12, height - 0.01);
    const backH = clamp(g.backHeight, 0.01, height - 0.005);
    const f = TEMPLATES.classic({ ...g, baffleEnabled: true, baffleHeight: bh });
    f.elements.push(panel('back', '背板', [ {u:T/2, d:height}, {u:T/2, d:height - backH} ], 0.2));
    return f;
  },
  // 上緣回折：經典 + 自前緣朝牆內的水平回折（中心線 d=bd-T/2）
  topReturn(g) {
    const T = THICK, { depth, height } = g;
    const safeBH = Math.min(g.baffleHeight, Math.max(0, height - 0.01));
    const bh = safeBH > 0.005 ? safeBH : Math.min(0.18, height - 0.01);
    const bd = height - bh, lip = clamp(g.lipDepth, 0.01, depth - 0.005), innerU = depth + T/2 - lip;
    const f = TEMPLATES.classic({ ...g, baffleEnabled: true, baffleHeight: bh });
    f.elements.push(panel('lip', '上緣回折', [ {u:innerU, d:bd - T/2}, {u:depth + T/2, d:bd - T/2} ], 0.2));
    return f;
  },
  // 空白：無元件，僅光源掛點（從零開始繪製）
  blank(g) {
    return { schema: 'cove-form@2', units: 'm', elements: [], fixture: coveLight(g), joints: [] };
  },
};
// 範本預設幾何參數（按「從範本」按鈕時用）
export const DEFAULT_GEOMETRY = {
  depth: 0.15, height: 0.40, baffleEnabled: true, baffleHeight: 0.12,
  lightWallDist: 0.09, lightPlateDist: 0.20, backHeight: 0.30, lipDepth: 0.06,
};
// 範本中文名（給按鈕/onboarding）
export const TEMPLATE_LABELS = {
  classic: '經典', uChannel: 'U 型槽', topReturn: '上緣回折', blank: '空白',
};
// 以範本建立新 form（深拷貝，確保可獨立編輯）
export function makeFormFromTemplate(name) {
  const f = (TEMPLATES[name] || TEMPLATES.classic)(DEFAULT_GEOMETRY);
  return JSON.parse(JSON.stringify(f));
}
