// Turns the forest layout into a Three.js scene, with the same simple shapes and colors as
// the Unreal version (AForestPatch). The layout is in Unreal units (cm, Z up); the scene is
// in meters with Y up, so Unreal (x, y, z) becomes Three.js (x, z, y) / 100.

import * as THREE from 'three';
import { perlin2 } from './noise.js';

export const CM = 0.01;

// Colors from ForestPatch.h (linear, like Unreal)
const COLORS = {
  ground: [0.10, 0.16, 0.05],
  path: [0.30, 0.22, 0.13],
  streamBed: [0.11, 0.09, 0.07],
  trunk: [0.16, 0.09, 0.05],
  conifer: [0.03, 0.10, 0.04],
  broadleaf: [0.08, 0.18, 0.04],
  rock: [0.30, 0.30, 0.28],
  grass: [0.12, 0.25, 0.05],
  water: [0.02, 0.07, 0.09],
  bridge: [0.25, 0.15, 0.08],
  log: [0.12, 0.08, 0.05],
  fern: [0.06, 0.17, 0.04],
  streamStone: [0.38, 0.36, 0.33],
};

// Conifer canopy: five overlapping, narrowing cones (start, end, radius as parts of the height)
const CONE_LAYERS = [
  [0.20, 0.52, 0.120],
  [0.35, 0.67, 0.098],
  [0.50, 0.82, 0.077],
  [0.65, 0.97, 0.055],
  [0.80, 1.00, 0.034],
];

// Bench boxes in cm around the bench center on the ground (it faces local -Y)
const BENCH_BOXES = [
  [[0, 0, 45], [160, 45, 6]],
  [[0, 20, 75], [160, 5, 40]],
  [[-70, 0, 21], [6, 40, 42]],
  [[70, 0, 21], [6, 40, 42]],
  [[-70, 20, 60], [6, 5, 30]],
  [[70, 20, 60], [6, 5, 30]],
];

const color = (rgb) => new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2]);

/** A repeatable random number in [0, 1) for an index. */
function hash(i) {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Time for the swaying grass, moved forward by the game every frame. */
export const wind = { time: { value: 0 } };

/** Makes the tops of a shape sway a little in the wind (each copy at its own pace), strength in meters. */
function addWind(material, strength) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.windTime = wind.time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float windTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 windBase = instanceMatrix[3].xyz;
        float windTop = clamp(position.y + 0.5, 0.0, 1.0);
        float windWave = sin(windTime * 1.7 + windBase.x * 0.37 + windBase.z * 0.29) + 0.4 * sin(windTime * 3.1 + windBase.x * 1.3);
        // (divided by the copy's size, so the sway is the same number of meters for every copy)
        transformed.x += windWave * ${strength.toFixed(3)} * windTop / length(instanceMatrix[0].xyz);
        transformed.z += windWave * ${(strength * 0.6).toFixed(3)} * windTop / length(instanceMatrix[2].xyz);`);
  };
  return material;
}

/**
 * Writes an Unreal transform into a Three.js matrix: position in cm, rotation as an Unreal
 * rotator in degrees (pitch, yaw, roll), scale relative to a 1 m shape (Unreal's 100 cm shapes).
 */
export function setUnrealMatrix(target, x, y, z, pitch, yaw, roll, sx, sy, sz) {
  const p = THREE.MathUtils.degToRad(pitch);
  const w = THREE.MathUtils.degToRad(yaw);
  const r = THREE.MathUtils.degToRad(roll);
  const SP = Math.sin(p), CP = Math.cos(p), SY = Math.sin(w), CY = Math.cos(w), SR = Math.sin(r), CR = Math.cos(r);
  // The turned Unreal axes, in Unreal coordinates
  const ax = [CP * CY, CP * SY, SP];
  const ay = [SR * SP * CY - CR * SY, SR * SP * SY + CR * CY, -SR * CP];
  const az = [-(CR * SP * CY + SR * SY), CY * SR - CR * SP * SY, CR * CP];
  // Three.js local x / y / z are Unreal's X / Z / Y; every vector swaps its Y and Z
  target.set(
    ax[0] * sx, az[0] * sz, ay[0] * sy, x * CM,
    ax[2] * sx, az[2] * sz, ay[2] * sy, z * CM,
    ax[1] * sx, az[1] * sz, ay[1] * sy, y * CM,
    0, 0, 0, 1,
  );
  return target;
}

/** Many copies of one shape in one draw call. */
class InstanceBatch {
  constructor(geometry, material, { castShadow = false, receiveShadow = false, variation = 0 } = {}) {
    this.geometry = geometry;
    this.material = material;
    this.matrices = [];
    this.castShadow = castShadow;
    this.receiveShadow = receiveShadow;
    this.variation = variation; // how much lighter or darker each copy may be (0.1 = 10%)
  }

  add(x, y, z, pitch, yaw, roll, sx, sy, sz) {
    this.matrices.push(setUnrealMatrix(new THREE.Matrix4(), x, y, z, pitch, yaw, roll, sx, sy, sz));
  }

  build(name) {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, Math.max(1, this.matrices.length));
    mesh.name = name;
    this.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    if (this.variation > 0) {
      // Each copy a little lighter or darker, and a touch more yellow or blue-green
      const c = new THREE.Color();
      this.matrices.forEach((_, i) => {
        const a = hash(i * 2 + 1) * 2 - 1;
        const b = hash(i * 2 + 2) * 2 - 1;
        const light = 1 + a * this.variation;
        c.setRGB(light * (1 + b * this.variation * 0.5), light, light * (1 - b * this.variation * 0.5));
        mesh.setColorAt(i, c);
      });
      mesh.instanceColor.needsUpdate = true;
    }
    mesh.count = this.matrices.length;
    mesh.castShadow = this.castShadow;
    mesh.receiveShadow = this.receiveShadow;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
  }
}

function buildGround(layout) {
  const n = layout.gridCount;
  const coords = layout.gridCoords;
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const ground = COLORS.ground;
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const i = gy * n + gx;
      const x = coords[gx];
      const y = coords[gy];
      positions.set([x * CM, layout.heights[i] * CM, y * CM], i * 3);
      // Ground with a little color variation, then path and stream bed on top
      const variation = 0.85 + 0.3 * (0.5 + 0.5 * perlin2(x / 700, y / 700));
      const pw = layout.pathWeight[i];
      const sw = layout.streamWeight[i];
      for (let c = 0; c < 3; c++) {
        let v = ground[c] * variation;
        v += (COLORS.path[c] - v) * pw;
        v += (COLORS.streamBed[c] - v) * sw;
        colors[i * 3 + c] = v;
      }
    }
  }
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let gy = 0; gy < n - 1; gy++) {
    for (let gx = 0; gx < n - 1; gx++) {
      const i0 = gy * n + gx;
      const i1 = i0 + 1;
      const i2 = i0 + n;
      const i3 = i2 + 1;
      // Faces point up (+Y in Three.js)
      indices.set([i0, i2, i1, i1, i2, i3], k);
      k += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = 'Ground';
  mesh.receiveShadow = true;
  return mesh;
}

function buildStreamRibbon(layout) {
  const line = layout.streamLine;
  const half = (layout.rules.StreamWidth * 0.5 + layout.rules.StreamBankWidth) * CM; // the banks hide the edges
  const y = layout.waterZ * CM;
  const positions = new Float32Array(line.length * 2 * 3);
  line.forEach((p, i) => {
    const a = line[Math.max(i - 1, 0)];
    const b = line[Math.min(i + 1, line.length - 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const sx = -dy / len;
    const sy = dx / len;
    positions.set([p.x * CM + sx * half, y, p.y * CM + sy * half, p.x * CM - sx * half, y, p.y * CM - sy * half], i * 6);
  });
  const indices = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const l0 = i * 2;
    const r0 = l0 + 1;
    const l1 = l0 + 2;
    const r1 = l0 + 3;
    indices.push(l0, l1, r0, r0, l1, r1); // wound so the top faces the sky
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Make every normal point up, whichever way the triangles wind
  const normals = geometry.attributes.normal;
  for (let i = 0; i < normals.count; i++) normals.setXYZ(i, 0, 1, 0);
  return geometry;
}

/** Builds the whole forest scene. Returns the scene and the things the game needs. */
export function buildWorld(layout) {
  const scene = new THREE.Scene(); // the sky, sun and fog come from sky.js

  scene.add(buildGround(layout));

  // Far ground well past the generated grid, hidden in the fog
  const farGround = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: color(COLORS.ground.map((v) => v * 0.9)) }),
  );
  farGround.position.y = -1.2;
  farGround.name = 'FarGround';
  scene.add(farGround);

  // Water: one sheet at stream level (the ground is above it except in the stream), and ponds
  const waterMaterial = new THREE.MeshPhongMaterial({
    color: color(COLORS.water),
    specular: new THREE.Color().setRGB(0.5, 0.55, 0.6),
    shininess: 80,
    transparent: true,
    opacity: 0.88,
    side: THREE.DoubleSide,
  });
  // The stream's water: a ribbon along the stream (a sheet over the whole forest would also
  // show through the see-through ponds as a dark patch)
  // (not see-through: where the ribbon folds over itself at a bend, two layers showed as a line)
  const streamMaterial = waterMaterial.clone();
  streamMaterial.transparent = false;
  streamMaterial.opacity = 1;
  const water = new THREE.Mesh(buildStreamRibbon(layout), streamMaterial);
  water.name = 'Water';
  water.receiveShadow = true;
  scene.add(water);
  for (const pond of layout.ponds) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(pond.radius * CM * 1.02, 48).rotateX(-Math.PI / 2), waterMaterial);
    disc.position.set(pond.x * CM, pond.waterZ * CM, pond.y * CM);
    disc.name = 'Pond';
    disc.receiveShadow = true;
    scene.add(disc);
  }

  // Shapes, all 1 m across and centered like Unreal's basic shapes
  // (kept low in detail for phones; ends that are never seen are left open)
  const trunkShape = new THREE.CylinderGeometry(0.5, 0.5, 1, 8); // (closed: the top shows from a climbed tree)
  const logShape = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  const cone = new THREE.ConeGeometry(0.5, 1, 8); // the base shows when looking up from under a tree
  const sphere = new THREE.SphereGeometry(0.5, 10, 8);
  const tuftShape = new THREE.ConeGeometry(0.5, 1, 5, 1, true); // grass and ferns stand on the ground
  const lowCone = new THREE.ConeGeometry(0.5, 1, 6);
  const rockShape = new THREE.IcosahedronGeometry(0.5, 1);
  const pebbleShape = new THREE.IcosahedronGeometry(0.5, 0); // small stream stones
  const farSphere = new THREE.SphereGeometry(0.5, 7, 5); // trees outside the walkable square
  const box = new THREE.BoxGeometry(1, 1, 1);
  const lambert = (rgb, extra = {}) => new THREE.MeshLambertMaterial({ color: color(rgb), ...extra });

  const trunks = new InstanceBatch(trunkShape, lambert(COLORS.trunk), { castShadow: true, receiveShadow: true, variation: 0.15 });
  const coniferLeaves = new InstanceBatch(cone, lambert(COLORS.conifer), { castShadow: true, receiveShadow: true, variation: 0.14 });
  const broadLeaves = new InstanceBatch(sphere, lambert(COLORS.broadleaf), { castShadow: true, receiveShadow: true, variation: 0.16 });
  const farConifers = new InstanceBatch(lowCone, lambert(COLORS.conifer), { variation: 0.12 });
  const farBroadleaves = new InstanceBatch(farSphere, lambert(COLORS.broadleaf), { variation: 0.12 });
  const rocks = new InstanceBatch(rockShape, lambert(COLORS.rock, { flatShading: true }), { castShadow: true, receiveShadow: true, variation: 0.15 });
  const stones = new InstanceBatch(pebbleShape, lambert(COLORS.streamStone, { flatShading: true }));
  const grass = new InstanceBatch(tuftShape, addWind(lambert(COLORS.grass), 0.04), { variation: 0.22 });
  const ferns = new InstanceBatch(tuftShape, addWind(lambert(COLORS.fern), 0.025), { receiveShadow: true, variation: 0.18 });
  const logs = new InstanceBatch(logShape, lambert(COLORS.log), { castShadow: true, receiveShadow: true });
  const wood = new InstanceBatch(box, lambert(COLORS.bridge), { castShadow: true, receiveShadow: true });

  const trunkColliders = [];
  const canopyOf = new Map(); // tree index -> where its leaves are in the leaf batches
  layout.trees.forEach((tree, treeIndex) => {
    const h = tree.height;
    if (tree.backdrop) {
      // One simple shape reaching down to the ground
      if (tree.broadleaf) farBroadleaves.add(tree.x, tree.y, tree.z + h * 0.55, 0, tree.yaw, 0, h * 0.0056, h * 0.0056, h * 0.009);
      else farConifers.add(tree.x, tree.y, tree.z + h * 0.5, 0, tree.yaw, 0, h * 0.003 * tree.slenderness, h * 0.003 * tree.slenderness, h * 0.01);
      return;
    }
    const trunkHeight = h * (tree.broadleaf ? 0.6 : 0.92);
    const sink = 30; // push the trunk into the ground so it never floats on slopes
    const d = (tree.trunkRadius * 2) / 100;
    trunks.add(tree.x, tree.y, tree.z + (trunkHeight - sink) * 0.5, 0, tree.yaw, 0, d, d, (trunkHeight + sink) / 100);
    trunkColliders.push({ x: tree.x, y: tree.y, radius: tree.trunkRadius, top: tree.z + trunkHeight });
    const leaves = tree.broadleaf ? broadLeaves : coniferLeaves;
    const firstLeaf = leaves.matrices.length;
    if (!tree.broadleaf) {
      for (const [start, end, radius] of CONE_LAYERS) {
        const bottom = h * start;
        const top = h * end;
        const width = (h * radius * tree.slenderness * 2) / 100;
        coniferLeaves.add(tree.x, tree.y, tree.z + (bottom + top) * 0.5, 0, tree.yaw, 0, width, width, (top - bottom) / 100);
      }
    } else {
      const r = h * 0.25;
      broadLeaves.add(tree.x, tree.y, tree.z + h * 0.68, 0, tree.yaw, 0, (r * 2) / 100, (r * 2) / 100, (r * 1.7) / 100);
      const yawRad = THREE.MathUtils.degToRad(tree.yaw);
      const ox = r * 0.45 * Math.cos(yawRad) - r * 0.2 * Math.sin(yawRad);
      const oy = r * 0.45 * Math.sin(yawRad) + r * 0.2 * Math.cos(yawRad);
      broadLeaves.add(tree.x + ox, tree.y + oy, tree.z + h * 0.82, 0, tree.yaw, 0, (r * 1.3) / 100, (r * 1.3) / 100, (r * 1.1) / 100);
    }
    canopyOf.set(treeIndex, { name: tree.broadleaf ? 'broadLeaves' : 'coniferLeaves', first: firstLeaf, count: leaves.matrices.length - firstLeaf });
  });

  for (const rock of layout.rocks) rocks.add(rock.x, rock.y, rock.z, rock.pitch, rock.yaw, rock.roll, rock.sx, rock.sy, rock.sz);
  for (const stone of layout.streamStones) stones.add(stone.x, stone.y, stone.z, 0, stone.yaw, 0, stone.sx, stone.sy, stone.sz);
  for (const tuft of layout.grass) {
    const height = 30 * tuft.scale;
    const width = 10 * tuft.scale;
    grass.add(tuft.x, tuft.y, tuft.z + height * 0.5 - 3, 0, tuft.yaw, 0, width / 100, width / 100, height / 100);
  }
  for (const fern of layout.ferns) {
    // A low, wide mound of leaves (a squashed cone)
    const width = 90 * fern.size;
    const height = 40 * fern.size;
    ferns.add(fern.x, fern.y, fern.z + height * 0.5 - 5, 0, fern.yaw, 0, width / 100, (width * 0.8) / 100, height / 100);
  }
  for (const log of layout.logs) {
    const d = (log.radius * 2) / 100;
    logs.add(log.x, log.y, log.z, log.pitch, log.yaw, 0, d, d, log.length / 100);
  }
  for (const bridge of layout.bridges) {
    wood.add(bridge.x, bridge.y, bridge.z, bridge.pitch, bridge.yaw, 0, bridge.length / 100, bridge.width / 100, bridge.thickness / 100);
  }
  for (const bench of layout.benches) {
    const yawRad = THREE.MathUtils.degToRad(bench.yaw);
    for (const [[cx, cy, cz], [bx, by, bz]] of BENCH_BOXES) {
      const x = bench.x + cx * Math.cos(yawRad) - cy * Math.sin(yawRad);
      const y = bench.y + cx * Math.sin(yawRad) + cy * Math.cos(yawRad);
      wood.add(x, y, bench.z + cz, 0, bench.yaw, 0, bx / 100, by / 100, bz / 100);
    }
  }

  const batches = { trunks, coniferLeaves, broadLeaves, farConifers, farBroadleaves, rocks, stones, grass, ferns, logs, wood };
  const meshes = {};
  for (const [name, batch] of Object.entries(batches)) {
    meshes[name] = batch.build(name);
    scene.add(meshes[name]);
  }

  // See-through leaves for the tree being climbed, so the player stays visible inside them
  const seeThrough = {
    coniferLeaves: new THREE.InstancedMesh(cone, lambert(COLORS.conifer, { transparent: true, opacity: 0.3, depthWrite: false }), 8),
    broadLeaves: new THREE.InstancedMesh(sphere, lambert(COLORS.broadleaf, { transparent: true, opacity: 0.3, depthWrite: false }), 8),
  };
  for (const mesh of Object.values(seeThrough)) {
    mesh.count = 0;
    mesh.name = 'SeeThroughLeaves';
    scene.add(mesh);
  }
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  let current = null;
  /** Makes one tree's leaves see-through (tree index), or puts them back (null). */
  function setSeeThrough(treeIndex) {
    if (current) {
      const mesh = meshes[current.name];
      for (let i = 0; i < current.count; i++) mesh.setMatrixAt(current.first + i, batches[current.name].matrices[current.first + i]);
      mesh.instanceMatrix.needsUpdate = true;
      seeThrough[current.name].count = 0;
      current = null;
    }
    const ref = treeIndex === null ? null : canopyOf.get(treeIndex);
    if (!ref) return;
    const mesh = meshes[ref.name];
    const copies = seeThrough[ref.name];
    for (let i = 0; i < ref.count; i++) {
      copies.setMatrixAt(i, batches[ref.name].matrices[ref.first + i]);
      mesh.setMatrixAt(ref.first + i, hidden);
    }
    copies.count = ref.count;
    copies.instanceMatrix.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    current = ref;
  }

  return { scene, trunkColliders, setSeeThrough };
}
