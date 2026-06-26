/**
 * LightSources.js
 * 燈條光源工廠 — 以 RectAreaLight 模擬線型燈條
 *
 * emissionAngle 控制總發光角度，rotationAngle 控制發光中心方向：
 *   rotationAngle 0° = 朝上
 *   rotationAngle +90° = 朝室內
 *   rotationAngle -90° = 朝槽後牆
 *   rotationAngle 180° = 朝下
 */

import * as THREE from 'three';
import { RectAreaLight } from 'three';

// ── 色溫轉 RGB（Tanner Helland approximation）──────────────────
export function kelvinToColor(K) {
  const t = K / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = t <= 2  ? 0   : 99.4708025861  * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446  * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return new THREE.Color(
    Math.max(0, Math.min(255, r)) / 255,
    Math.max(0, Math.min(255, g)) / 255,
    Math.max(0, Math.min(255, b)) / 255
  );
}

// ── 輔助 ─────────────────────────────────────────────────────

// 建立沿牆延伸，並朝指定方向發光的 RectAreaLight
function makeRect(color, intensity, len, position, wall, direction) {
  const light = new RectAreaLight(color, intensity, len, 0.01);
  light.position.copy(position);
  orientRectAreaLight(light, wall, direction);
  return light;
}

function stripTangent(wall) {
  return (wall === 'north' || wall === 'south')
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 0, 1);
}

function orientRectAreaLight(light, wall, direction) {
  const xAxis = stripTangent(wall);
  const emitDir = direction.clone().normalize();
  const zAxis = emitDir.clone().negate();
  const yAxis = zAxis.clone().cross(xAxis).normalize();

  const m = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  light.quaternion.setFromRotationMatrix(m);
}

// "入室"方向（room-facing direction for each wall）
function wallForwardDir(wall) {
  switch (wall) {
    case 'north': return new THREE.Vector3(0, 0,  1);
    case 'south': return new THREE.Vector3(0, 0, -1);
    case 'east':  return new THREE.Vector3(-1, 0, 0);
    case 'west':  return new THREE.Vector3( 1, 0, 0);
    default:      return new THREE.Vector3(0, 0,  1);
  }
}

function directionFromAngle(wall, rotationAngle) {
  const rad = rotationAngle * Math.PI / 180;
  const fwd = wallForwardDir(wall);
  return new THREE.Vector3(0, Math.cos(rad), 0)
    .addScaledVector(fwd, Math.sin(rad));
}

/**
 * 依 emissionAngle 建立一組 RectAreaLight，讓 3D 光源與剖面光線圖使用相同角度語意。
 */
export function buildAngledLights({ color, intensity, len, position, wall, emissionAngle, rotationAngle }) {
  const spread = THREE.MathUtils.clamp(emissionAngle ?? 180, 10, 360);
  const center = rotationAngle ?? 0;
  const count = Math.max(1, Math.min(8, Math.ceil(spread / 45)));
  const start = center - spread / 2;
  const step = count === 1 ? 0 : spread / (count - 1);
  const lightIntensity = intensity / count;

  return Array.from({ length: count }, (_, i) => {
    const angle = count === 1 ? center : start + step * i;
    const light = makeRect(color, lightIntensity, len, position, wall, directionFromAngle(wall, angle));
    light.userData.coveIntensityScale = 1 / count;
    return light;
  });
}
