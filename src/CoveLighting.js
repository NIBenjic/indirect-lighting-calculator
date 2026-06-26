/**
 * CoveLighting.js
 * 燈槽幾何 + 光源管理
 *
 * 燈槽剖面（沿牆頂部）：
 *
 *  Ceiling ────────────────────────────
 *           [  cove top  ]
 *  [wall]   [  cove back ] [LED strip] ← position.y = (roomH - coveOffset - coveHeight) + coveHeight * lightHeightRatio
 *           [  baffle    ]             ← 遮光擋板，遮住光源
 *  [wall]
 *  Floor
 */

import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { buildAngledLights, kelvinToColor } from './LightSources.js';

RectAreaLightUniformsLib.init();

// 燈槽外觀材質 (霧面白)
const coveMat = new THREE.MeshStandardMaterial({
  color: 0xfafafa,
  roughness: 0.9,
  metalness: 0,
  side: THREE.FrontSide,
});

// 假陰影材質（共用，不在 _clearGroup 中 dispose）
const shadowHintMat = new THREE.MeshBasicMaterial({
  color:      0x000000,
  transparent: true,
  opacity:    0.32,
  depthWrite: false,
  side:       THREE.FrontSide,
});

export class CoveLighting {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'CoveLighting';

    // 燈槽幾何群組 (可整個清除重建)
    this.geoGroup   = new THREE.Group();
    this.lightGroup = new THREE.Group();
    this.shadowGroup = new THREE.Group();  // 假陰影平面
    this.group.add(this.geoGroup, this.lightGroup, this.shadowGroup);

    // 當前 Three.js light 物件列表
    this._lights = [];
    // LED 燈條自發光材質（用於 updateKelvin 同步顏色）
    this._stripMaterials = [];

    this.params = {
      depth:       0.15,  // 燈槽深度 (m)
      height:      0.12,  // 燈槽高度 (m)
      offset:      0.05,  // 距天花板距離 (m)
      baffleEnabled: true,   // 擋板是否可見
      baffleHeight:  0.12,   // 擋板高度 (m)，可獨立調整
      lightDist:        0.6,   // 光源距後牆比例 (0~1，相對於 depth)
      lightHeightRatio: 0.5,  // 光源距底板比例 (0=底板, 1=頂部)
      emissionAngle:    180,  // 發光角度 (total spread, 10°~360°)
      rotationAngle:    0,    // 自體旋轉角度 (0°=朝上, +90°=朝室內, -90°=朝槽後牆)
      walls: {
        north: true,
        south: true,
        east:  true,
        west:  true,
      },
      lightIntensity: 600,
      lightKelvin:    3000,
    };
  }

  // ── 主要重建 ─────────────────────────────────────────────────
  rebuild(roomWidth, roomDepth, roomHeight) {
    this._roomW = roomWidth;
    this._roomD = roomDepth;
    this._roomH = roomHeight;

    // 清除舊物件
    for (const mat of this._stripMaterials) mat.dispose();
    this._clearGroup(this.geoGroup);
    this._clearGroup(this.lightGroup);
    this._clearGroup(this.shadowGroup);
    this._lights = [];
    this._stripMaterials = [];

    const { depth, height, offset, baffleEnabled, baffleHeight, lightDist, lightHeightRatio, emissionAngle, rotationAngle, walls, lightIntensity } = this.params;
    const maxBaffleHeight = Math.max(0, height - 0.01);
    const safeBaffleHeight = Math.min(Math.max(baffleHeight, 0), maxBaffleHeight);
    const safeLightDist = THREE.MathUtils.clamp(lightDist, 0.05, 0.95);
    const W = roomWidth, D = roomDepth, H = roomHeight;

    // 光源顏色由色溫決定
    const finalColor = kelvinToColor(this.params.lightKelvin);

    const wallDefs = [
      {
        key: 'north',
        // 燈槽沿 X 軸放置，z = -D/2 + depth/2
        len: W - depth * 2,   // 扣除角落重疊
        cx:  0,
        cz: -D / 2 + depth,
        rotY: 0,
      },
      {
        key: 'south',
        len: W - depth * 2,
        cx:  0,
        cz:  D / 2 - depth,
        rotY: Math.PI,
      },
      {
        key: 'west',
        len: D - depth * 2,
        cx: -W / 2 + depth,
        cz:  0,
        rotY: Math.PI / 2,
      },
      {
        key: 'east',
        len: D - depth * 2,
        cx:  W / 2 - depth,
        cz:  0,
        rotY: -Math.PI / 2,
      },
    ];

    const safeHeightRatio = THREE.MathUtils.clamp(lightHeightRatio ?? 0.5, 0.05, 0.95);
    const cY = (H - offset - height) + height * safeHeightRatio; // 光源 Y（可調）

    // ── 幾何裁切：限制 3D 燈具的有效發光角度，避免 RectAreaLight 穿透底板/擋板 ──
    // RectAreaLight 不支援陰影，所以在建立前直接剪掉被擋住的方向。
    const bottomY_geo   = H - offset - height;
    const baffleTop_geo = bottomY_geo + (baffleEnabled && safeBaffleHeight > 0.005 ? safeBaffleHeight : 0);
    const lightX_geo    = depth * safeLightDist;
    const lightY_geo    = cY;

    // 右側極限：射線剛好能越過擋板頂端的臨界角（從垂直量起，向室內為正）
    let angleRight;
    if (baffleEnabled && safeBaffleHeight > 0.005 && lightY_geo < baffleTop_geo) {
      angleRight = Math.atan2(depth - lightX_geo, baffleTop_geo - lightY_geo) * (180 / Math.PI);
    } else {
      angleRight = 90; // 無擋板 or 光源在擋板頂端以上 → 水平向室內
    }
    const angleLeft = -90; // 向後牆水平方向（向下更多會打到牆/底板）

    // 將使用者設定的角度範圍裁切到有效區間
    const rawCenter = rotationAngle ?? 0;
    const rawHalf   = (emissionAngle ?? 180) / 2;
    const effMin = Math.max(rawCenter - rawHalf, angleLeft);
    const effMax = Math.min(rawCenter + rawHalf, angleRight);

    let effEmission, effRotation;
    if (effMin >= effMax) {
      // 完全被遮蔽 → 朝最近有效方向射出極小角度的光
      effRotation = THREE.MathUtils.clamp(rawCenter, angleLeft, angleRight);
      effEmission = 1;
    } else {
      effEmission = effMax - effMin;
      effRotation = (effMin + effMax) / 2;
    }

    for (const wd of wallDefs) {
      if (!walls[wd.key]) continue;

      this._buildCoveGeometry(wd, cY, depth, height, H, offset, baffleEnabled, safeBaffleHeight);
      this._buildCoveLights(wd, cY, depth, height, finalColor, lightIntensity, effEmission, effRotation, W, D, safeLightDist);
    }

    // 假陰影：依擋板遮光幾何，在天花板貼深色半透明平面
    this._buildShadowHints(wallDefs, depth, H, baffleEnabled, safeBaffleHeight, safeLightDist, cY, bottomY_geo);
  }

  // ── 建構燈槽幾何 ──────────────────────────────────────────────
  _buildCoveGeometry(wd, cY, depth, height, roomH, offset, baffleEnabled, baffleHeight) {
    const { cx, cz, len, rotY } = wd;
    const g = new THREE.Group();
    g.rotation.y = rotY;
    g.position.set(cx, 0, cz);

    const thick = 0.015; // 板厚

    const bottomY = roomH - offset - height; // 底板 Y 座標

    // 1. 下檔板 (bottom plate) — 水平，一端靠牆、一端在燈槽開口
    const bottomGeo = new THREE.BoxGeometry(len, thick, depth);
    const bottomMesh = new THREE.Mesh(bottomGeo, coveMat);
    bottomMesh.position.set(0, bottomY, -depth / 2);
    bottomMesh.castShadow = true;
    g.add(bottomMesh);

    // 2. 側擋板 (side baffle) — 垂直，連接底板前緣向上遮光
    if (baffleEnabled && baffleHeight > 0.005) {
      const baffleGeo = new THREE.BoxGeometry(len, baffleHeight, thick);
      const baffleMesh = new THREE.Mesh(baffleGeo, coveMat);
      // 底部對齊底板，向上延伸
      baffleMesh.position.set(0, bottomY + baffleHeight / 2, 0);
      baffleMesh.castShadow = true;
      g.add(baffleMesh);
    }

    this.geoGroup.add(g);
  }

  // ── 建構光源 ─────────────────────────────────────────────────
  _buildCoveLights(wd, cY, depth, height, color, intensity, emissionAngle, rotationAngle, roomW, roomD, lightDist) {
    const { cx, cz, len, key } = wd;

    const lightXZ = this._wallOffset(key, -depth * (1 - lightDist), roomW, roomD);
    const pos = new THREE.Vector3(cx + lightXZ.x, cY, cz + lightXZ.z);

    const lights = buildAngledLights({ color, intensity, len, position: pos, wall: key, emissionAngle, rotationAngle });
    for (const light of lights) {
      light.userData.coveWall = key;
      this.lightGroup.add(light);
      this._lights.push(light);
    }

    // 燈條自發光 mesh — 讓擋板在視覺上能遮住光源
    const isNS = key === 'north' || key === 'south';
    const sLen  = len;  // 燈條長度與燈槽同寬
    const sGeo  = isNS
      ? new THREE.BoxGeometry(sLen, 0.012, 0.012)
      : new THREE.BoxGeometry(0.012, 0.012, sLen);
    const sMat = new THREE.MeshStandardMaterial({
      color:            color.clone(),
      emissive:         color.clone(),
      emissiveIntensity: 3,
      roughness: 0,
      metalness: 0,
    });
    this._stripMaterials.push(sMat);
    const sMesh = new THREE.Mesh(sGeo, sMat);
    sMesh.position.copy(pos);
    this.geoGroup.add(sMesh);
  }

  // ── 假陰影提示：依擋板幾何在天花板貼深色半透明帶 ──────────────
  _buildShadowHints(wallDefs, depth, roomH, baffleEnabled, baffleHeight, lightDist, lightY, bottomY) {
    // 只在擋板存在且光源低於擋板頂端時才有陰影
    if (!baffleEnabled || baffleHeight <= 0.005) return;

    const baffleTop = bottomY + baffleHeight;
    if (lightY >= baffleTop) return;   // 光源已高過擋板，無遮蔽

    const lightX = depth * lightDist;  // 光源距牆距離（局部座標）

    // 從光源射向擋板頂端的射線，延伸到天花板 (y = roomH)
    const dx = depth - lightX;          // 水平分量（朝開口方向）
    const dy = baffleTop - lightY;      // 垂直分量（向上）

    const tCeil = (roomH - lightY) / dy;
    const xCeil = lightX + tCeil * dx;  // 射線抵達天花板時的局部 x

    if (xCeil <= depth) return;         // 陰影邊界在燈槽開口內側，不顯示

    // 陰影帶寬度 = 擋板頂至天花板交點，超出燈槽開口的部分
    const shadowW = xCeil - depth;

    for (const wd of wallDefs) {
      if (!this.params.walls[wd.key]) continue;

      const { cx, cz, len, key } = wd;
      const isNS = key === 'north' || key === 'south';

      // 陰影帶中心（世界座標），置於天花板下方 0.5mm 避免 z-fighting
      let wx, wz;
      if (key === 'north') { wx = cx;               wz = cz + shadowW / 2; }
      else if (key === 'south') { wx = cx;           wz = cz - shadowW / 2; }
      else if (key === 'west')  { wx = cx + shadowW / 2; wz = cz; }
      else                      { wx = cx - shadowW / 2; wz = cz; }  // east

      // PlaneGeometry 預設朝 +Y；繞 X 轉 -90° 後貼合天花板（朝下）
      const pw = isNS ? len   : shadowW;
      const ph = isNS ? shadowW : len;
      const geo = new THREE.PlaneGeometry(pw, ph);
      const mesh = new THREE.Mesh(geo, shadowHintMat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(wx, roomH - 0.0005, wz);
      this.shadowGroup.add(mesh);
    }
  }

  // 計算光源偏移，讓光線從槽內往正確方向發射
  _wallOffset(wall, dist, W, D) {
    switch (wall) {
      case 'north': return { x: 0,    z:  dist };
      case 'south': return { x: 0,    z: -dist };
      case 'east':  return { x: -dist, z: 0    };
      case 'west':  return { x:  dist, z: 0    };
      default:      return { x: 0,    z: 0     };
    }
  }

  // ── 即時更新 (不需重建幾何) ──────────────────────────────────
  updateLightIntensity(value) {
    this.params.lightIntensity = value;
    for (const light of this._lights) {
      const scale = light.userData.coveIntensityScale ?? 1;
      light.intensity = value * scale;
    }
  }

  updateKelvin(K) {
    this.params.lightKelvin = K;
    const final = kelvinToColor(K);
    for (const light of this._lights) {
      light.color.copy(final);
    }
    for (const mat of this._stripMaterials) {
      mat.color.copy(final);
      mat.emissive.copy(final);
      mat.needsUpdate = true;
    }
  }

  // ── 工具 ─────────────────────────────────────────────────────
  _clearGroup(group) {
    while (group.children.length) {
      const c = group.children[0];
      c.traverse((obj) => {
        if (obj instanceof THREE.Light) obj.dispose();
        if (obj.geometry) obj.geometry.dispose();
        // Don't dispose shared coveMat here; strip materials are disposed in rebuild()
      });
      group.remove(c);
    }
  }

  get lights() { return this._lights; }
}
