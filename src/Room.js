/**
 * Room.js
 * 建立空間幾何：四面牆 + 天花板 + 地板
 * 每個面使用獨立 MeshStandardMaterial，方便個別設定顏色與反光係數
 */

import * as THREE from 'three';

export const SURFACE_KEYS = ['north', 'south', 'east', 'west', 'ceiling', 'floor'];

export class Room {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'Room';

    // surface key → { mesh, material }
    this.surfaces = {};

    // 預設參數
    this.params = {
      width: 8,    // X
      depth: 6,    // Z
      height: 3,   // Y
    };

    this._buildMaterials();
    this._buildGeometry();
  }

  // ── 材質 ────────────────────────────────────────────────────
  _buildMaterials() {
    const defaults = {
      ceiling: { color: '#f5f5f0', reflectance: 0.85 },
      north:   { color: '#e8e8e8', reflectance: 0.75 },
      south:   { color: '#e8e8e8', reflectance: 0.75 },
      east:    { color: '#e8e8e8', reflectance: 0.75 },
      west:    { color: '#e8e8e8', reflectance: 0.75 },
      floor:   { color: '#8b7355', reflectance: 0.35 },
    };

    this.materials = {};
    for (const key of SURFACE_KEYS) {
      const d = defaults[key];
      this.materials[key] = new THREE.MeshStandardMaterial({
        color: new THREE.Color(d.color),
        roughness: 1.0 - d.reflectance * 0.6,  // 轉換為 PBR roughness (高反光 → 低粗糙)
        metalness: 0,
        side: THREE.FrontSide,
        name: key,
      });
      // 保存自訂反光係數
      this.materials[key].userData.reflectance = d.reflectance;
      this.materials[key].userData.hexColor    = d.color;
    }
  }

  // ── 幾何建構 ─────────────────────────────────────────────────
  _buildGeometry() {
    const { width: W, depth: D, height: H } = this.params;

    const specs = this._surfaceSpecs(W, D, H);
    for (const key of SURFACE_KEYS) {
      const spec = specs[key];
      const geo = new THREE.PlaneGeometry(spec.w, spec.h, 8, 8);
      const mesh = new THREE.Mesh(geo, this.materials[key]);
      mesh.position.set(...spec.pos);
      mesh.rotation.set(...spec.rot);
      mesh.receiveShadow = true;
      mesh.name = key;
      this.group.add(mesh);
      this.surfaces[key] = { mesh };
    }
  }

  _surfaceSpecs(W, D, H) {
    return {
      // 地板
      floor:   { w: W, h: D, pos: [0, 0, 0],          rot: [-Math.PI/2, 0, 0] },
      // 天花板 (法線朝下 → 旋轉 π)
      ceiling: { w: W, h: D, pos: [0, H, 0],           rot: [Math.PI/2, 0, 0] },
      // 北牆 (-Z 方向，面朝室內 +Z)
      north:   { w: W, h: H, pos: [0, H/2, -D/2],      rot: [0, 0, 0] },
      // 南牆 (+Z 方向，面朝室內 -Z)
      south:   { w: W, h: H, pos: [0, H/2,  D/2],      rot: [0, Math.PI, 0] },
      // 東牆 (+X 方向，面朝室內 -X)
      east:    { w: D, h: H, pos: [ W/2, H/2, 0],      rot: [0, -Math.PI/2, 0] },
      // 西牆 (-X 方向，面朝室內 +X)
      west:    { w: D, h: H, pos: [-W/2, H/2, 0],      rot: [0,  Math.PI/2, 0] },
    };
  }

  // ── 更新尺寸 ─────────────────────────────────────────────────
  updateSize(width, depth, height) {
    this.params = { width, depth, height };
    // 移除舊 mesh
    for (const key of SURFACE_KEYS) {
      if (this.surfaces[key]) {
        this.group.remove(this.surfaces[key].mesh);
        this.surfaces[key].mesh.geometry.dispose();
      }
    }
    this.surfaces = {};
    this._buildGeometry();
  }

  // ── 更新表面材質 ─────────────────────────────────────────────
  setSurfaceColor(key, hexColor) {
    this.materials[key].color.set(hexColor);
    this.materials[key].userData.hexColor = hexColor;
  }

  setSurfaceReflectance(key, value) {
    this.materials[key].roughness = 1.0 - value * 0.6;
    this.materials[key].userData.reflectance = value;
  }

  // ── Radiosity 應用 ────────────────────────────────────────────
  // 套用預先計算的 radiosity 顏色到每個面的頂點色
  applyRadiosityColors(radiosityMap) {
    for (const [key, color] of Object.entries(radiosityMap)) {
      const mesh = this.surfaces[key]?.mesh;
      if (!mesh) continue;
      const geo = mesh.geometry;
      const count = geo.attributes.position.count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        colors[i * 3]     = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      this.materials[key].vertexColors = true;
      this.materials[key].needsUpdate  = true;
    }
  }

  clearRadiosityColors() {
    for (const key of SURFACE_KEYS) {
      const mesh = this.surfaces[key]?.mesh;
      if (!mesh) continue;
      const geo = mesh.geometry;
      geo.deleteAttribute('color');
      this.materials[key].vertexColors = false;
      this.materials[key].needsUpdate  = true;
    }
  }

  // ── 查詢 ─────────────────────────────────────────────────────
  get width()  { return this.params.width; }
  get depth()  { return this.params.depth; }
  get height() { return this.params.height; }
}
