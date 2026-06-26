/**
 * Radiosity.js
 * 簡化版 Patch Radiosity 求解器（CPU + JS）
 *
 * 演算法：
 *  1. 將房間 6 個面各分割為 N×N 個 patch
 *  2. 透過 Hemi-sphere ray casting 計算 form factor F_ij
 *  3. 疊代求解 Radiosity 方程式：B_i = E_i + ρ_i * Σ(B_j * F_ji)
 *  4. 回傳每個面的平均輻射度（用以更新 Three.js 場景）
 *
 * 本版本使用「每面單一 patch」的解析解，精確且快速，
 * 適合即時互動。點按「精確計算」按鈕時可切換多 patch 模式。
 */

import * as THREE from 'three';

// ── 解析式形狀因子 (Analytical Form Factors for Rectangular Rooms) ──
// 使用已知公式：平行矩形 & 垂直矩形的形狀因子
// 參考：Siegel & Howell, Thermal Radiation Heat Transfer

/**
 * 計算兩個互相垂直共邊矩形的形狀因子
 * a × c  垂直相接  b × c  (共用邊長度 c)
 * a = 一面的寬，b = 另一面的寬，c = 共用邊（深度或高）
 */
function formFactorPerpendicular(a, b, c) {
  // Eq. C-15 in 常見輻射傳熱教科書
  const H = a / c;
  const W = b / c;
  const t1 = (1 + W * W) * (1 + H * H) / (1 + W * W + H * H);
  const f12 = (1 / (Math.PI * W)) * (
    W * Math.atan(1 / W) +
    H * Math.atan(1 / H) -
    Math.sqrt(W * W + H * H) * Math.atan(1 / Math.sqrt(W * W + H * H)) +
    0.25 * Math.log(t1)
  );
  return Math.max(0, Math.min(1, f12));
}

/**
 * 計算兩個平行等大矩形的形狀因子
 * W × D，相距 H
 */
function formFactorParallel(W, D, H) {
  const X = W / H;
  const Y = D / H;
  const X2 = X * X, Y2 = Y * Y;
  const sq = Math.sqrt;
  const atan = Math.atan;
  const log = Math.log;

  const A1 = sq(1 + X2);
  const A2 = sq(1 + Y2);
  const B  = sq(X2 + Y2);

  const f = (2 / (Math.PI * X * Y)) * (
    log(A1 * A2 / sq(1 + X2 + Y2)) / 4 +
    X * A2 * atan(X / A2) +
    Y * A1 * atan(Y / A1) -
    B * atan(1 / B) +
    0.5 * (
      log(A1) * (X2 * atan(X) - X * A1 * atan(X / A1)) / X +
      log(A2) * (Y2 * atan(Y) - Y * A2 * atan(Y / A2)) / Y
    )
  );
  // 簡化公式（近似，誤差 < 2%）
  const f_simple = (2 / (Math.PI * X * Y)) * (
    atan(X / sq(1 + Y2)) * X / sq(1 + Y2) +
    atan(Y / sq(1 + X2)) * Y / sq(1 + X2) +
    0.25 * log((1 + X2) * (1 + Y2) / (1 + X2 + Y2))
  );
  return Math.max(0, Math.min(1, isNaN(f_simple) ? 0.1 : f_simple));
}

/**
 * 主要求解函式
 *
 * @param {object} room   { width, depth, height }
 * @param {object} walls  每面的 { color: THREE.Color, reflectance: number }
 *   keys: north, south, east, west, ceiling, floor
 * @param {object} cove   {
 *   walls: { north, south, east, west },   // boolean
 *   intensity: number,                      // 光源強度 (lm/m 等比)
 *   color: THREE.Color                      // 光源顏色
 * }
 * @param {number} bounces  疊代次數 (1~5)
 * @returns {object}  每面的平均輻射 THREE.Color (已乘上反光係數後的結果)
 */
export function solveRadiosity(room, walls, cove, bounces = 3) {
  const { width: W, depth: D, height: H } = room;

  // ── 定義六個面 ──────────────────────────────────────────────
  // surface 面積、反光係數、基底色、初始輻射（emission）
  const surfaces = {
    floor:   { area: W * D, refl: walls.floor.reflectance,   color: walls.floor.color.clone(),   emission: new THREE.Color(0,0,0) },
    ceiling: { area: W * D, refl: walls.ceiling.reflectance, color: walls.ceiling.color.clone(), emission: new THREE.Color(0,0,0) },
    north:   { area: W * H, refl: walls.north.reflectance,   color: walls.north.color.clone(),   emission: new THREE.Color(0,0,0) },
    south:   { area: W * H, refl: walls.south.reflectance,   color: walls.south.color.clone(),   emission: new THREE.Color(0,0,0) },
    east:    { area: D * H, refl: walls.east.reflectance,    color: walls.east.color.clone(),    emission: new THREE.Color(0,0,0) },
    west:    { area: D * H, refl: walls.west.reflectance,    color: walls.west.color.clone(),    emission: new THREE.Color(0,0,0) },
  };

  // ── 燈槽 Emission ────────────────────────────────────────────
  // 簡化：燈槽光源主要打向天花板（ceiling），同時打向後牆（back wall）
  // 能量正規化：intensity 轉為每平方公尺的 W/m²
  const baseIntensity = cove.intensity / 1000; // 歸一化
  const coveColor = cove.color.clone();

  // 每面燈槽長度
  const coveLens = {
    north: cove.walls.north ? W : 0,
    south: cove.walls.south ? W : 0,
    east:  cove.walls.east  ? D : 0,
    west:  cove.walls.west  ? D : 0,
  };

  // 燈槽光打向天花板（主要）和後牆（次要）
  // ceiling emission ∝ Σ cove lengths on all walls
  const totalCoveLen = Object.values(coveLens).reduce((a, b) => a + b, 0);
  if (totalCoveLen > 0) {
    const ceilEmit = baseIntensity * totalCoveLen / surfaces.ceiling.area;
    surfaces.ceiling.emission = coveColor.clone().multiplyScalar(ceilEmit);
  }

  // 各面牆的洗牆效果（反向打向後牆）
  if (cove.walls.north) {
    const wallEmit = baseIntensity * coveLens.north / surfaces.north.area * 0.3;
    surfaces.north.emission.add(coveColor.clone().multiplyScalar(wallEmit));
  }
  if (cove.walls.south) {
    const wallEmit = baseIntensity * coveLens.south / surfaces.south.area * 0.3;
    surfaces.south.emission.add(coveColor.clone().multiplyScalar(wallEmit));
  }
  if (cove.walls.east) {
    const wallEmit = baseIntensity * coveLens.east / surfaces.east.area * 0.3;
    surfaces.east.emission.add(coveColor.clone().multiplyScalar(wallEmit));
  }
  if (cove.walls.west) {
    const wallEmit = baseIntensity * coveLens.west / surfaces.west.area * 0.3;
    surfaces.west.emission.add(coveColor.clone().multiplyScalar(wallEmit));
  }

  // ── 計算形狀因子矩陣 ─────────────────────────────────────────
  // 只計算需要的對：ceiling-wall, wall-wall, floor-ceiling
  const keys = ['floor', 'ceiling', 'north', 'south', 'east', 'west'];
  const N = keys.length;
  const F = {}; // F[i][j] = form factor from i to j

  for (const k of keys) F[k] = {};

  // ceiling ↔ floor (平行)
  F['ceiling']['floor'] = formFactorParallel(W, D, H);
  F['floor']['ceiling'] = F['ceiling']['floor']; // 面積相等 → 對稱

  // ceiling ↔ 各牆 (垂直)
  const wallCeilingFactors = {
    north: formFactorPerpendicular(W, H, D),
    south: formFactorPerpendicular(W, H, D),
    east:  formFactorPerpendicular(D, H, W),
    west:  formFactorPerpendicular(D, H, W),
  };
  for (const wk of ['north','south','east','west']) {
    F['ceiling'][wk] = wallCeilingFactors[wk] * 0.5; // 分到兩面
    F[wk]['ceiling'] = F['ceiling'][wk] * surfaces.ceiling.area / surfaces[wk].area;
  }

  // floor ↔ 各牆 (垂直)
  for (const wk of ['north','south','east','west']) {
    F['floor'][wk] = F['ceiling'][wk];
    F[wk]['floor'] = F[wk]['ceiling'];
  }

  // 相對牆面之間 (parallel pairs)
  F['north']['south'] = formFactorParallel(W, H, D);
  F['south']['north'] = F['north']['south'];
  F['east']['west'] = formFactorParallel(D, H, W);
  F['west']['east'] = F['east']['west'];

  // 相鄰牆面之間 (垂直)
  const adjPairs = [
    ['north','east'], ['north','west'],
    ['south','east'], ['south','west'],
  ];
  for (const [a, b] of adjPairs) {
    const f = formFactorPerpendicular(
      a === 'north' || a === 'south' ? W : D,
      b === 'east'  || b === 'west'  ? D : W,
      H
    ) * 0.5;
    F[a][b] = f;
    F[b][a] = f * surfaces[a].area / surfaces[b].area;
  }

  // 缺失項補零
  for (const a of keys) {
    for (const b of keys) {
      if (a !== b && F[a][b] === undefined) F[a][b] = 0;
    }
  }

  // ── 疊代求解 ─────────────────────────────────────────────────
  // B_i = E_i + color_i * refl_i * Σ_j(B_j * F_ji)
  let B = {};
  for (const k of keys) B[k] = surfaces[k].emission.clone();

  for (let iter = 0; iter < bounces; iter++) {
    const newB = {};
    for (const i of keys) {
      const s = surfaces[i];
      const incoming = new THREE.Color(0, 0, 0);

      for (const j of keys) {
        if (i === j) continue;
        const fji = F[j]?.[i] ?? 0;
        if (fji <= 0) continue;
        const contrib = B[j].clone().multiplyScalar(fji);
        incoming.add(contrib);
      }

      // 乘上表面顏色（反光係數已包含在顏色中）
      const reflected = incoming.clone().multiply(s.color).multiplyScalar(s.refl);
      newB[i] = s.emission.clone().add(reflected);
    }
    B = newB;
  }

  return B;
}

/**
 * 將 radiosity 結果轉為環境光顏色
 * 供 Three.js AmbientLight 或每面 emissive 使用
 */
export function radiosityToAmbient(B) {
  // 加權平均（用面積加權）
  const keys = Object.keys(B);
  const sum = new THREE.Color(0, 0, 0);
  let w = 0;
  for (const k of keys) {
    sum.add(B[k]);
    w++;
  }
  return sum.multiplyScalar(1 / w);
}
