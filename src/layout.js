// The forest layout: ground heights, path, stream and every object, worked out from the
// rules. A line-by-line copy of FForestLayout (Source/Forest/ForestRules.cpp), so the same
// rules give the same forest. Unreal's units and axes: centimeters, X/Y on the ground, Z up.
// If the C++ changes, change this too.

import { RandomStream, randBetween, partSeed } from './random.js';
import { fractalNoise } from './noise.js';

const SMALL_NUMBER = Math.fround(1e-8);
const BIG = Number.MAX_VALUE;

// Rules stored as int32 in C++; every other number rule is a 32-bit float there
const INT_RULES = new Set(['Seed', 'RockCount', 'FallenLogCount', 'StreamStoneCount', 'PondCount']);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const roundToInt = (v) => Math.floor(v + 0.5);
const degToRad = (d) => d * (Math.PI / 180);
const radToDeg = (r) => r * (180 / Math.PI);
const distance = (ax, ay, bx, by) => {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
};

function smoothStep(a, b, x) {
  if (Math.abs(a - b) <= SMALL_NUMBER) {
    return x < a ? 0 : 1;
  }
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function safeNormal(x, y) {
  const sq = x * x + y * y;
  if (sq > SMALL_NUMBER) {
    const s = 1 / Math.sqrt(sq);
    return { x: x * s, y: y * s };
  }
  return { x: 0, y: 0 };
}

/** Index i of the grid cell containing v, so coords[i] <= v <= coords[i + 1] (clamped). */
function findCell(coords, v) {
  let lo = 0;
  let hi = coords.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (coords[mid] > v) hi = mid;
    else lo = mid + 1;
  }
  return clamp(lo - 1, 0, coords.length - 2);
}

/** Squared distance from P to segment AB; the closest point goes into out. */
function distSqToSegment(px, py, ax, ay, bx, by, out) {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq > 0 ? clamp(((px - ax) * abx + (py - ay) * aby) / lenSq, 0, 1) : 0;
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  if (out) {
    out.x = cx;
    out.y = cy;
  }
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/** Catmull-Rom curve through the control points, sampled about every step cm. */
function sampleCurve(ctrl, step) {
  const out = [];
  for (let i = 0; i + 1 < ctrl.length; i++) {
    const p0 = ctrl[Math.max(i - 1, 0)];
    const p1 = ctrl[i];
    const p2 = ctrl[i + 1];
    const p3 = ctrl[Math.min(i + 2, ctrl.length - 1)];
    const steps = Math.max(1, Math.ceil(distance(p1.x, p1.y, p2.x, p2.y) / step));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const point = (k) =>
        (p1[k] * 2 + (p2[k] - p0[k]) * t + (p0[k] * 2 - p1[k] * 5 + p2[k] * 4 - p3[k]) * t2 + (p1[k] * 3 - p0[k] - p2[k] * 3 + p3[k]) * t3) * 0.5;
      out.push({ x: point('x'), y: point('y') });
    }
  }
  if (ctrl.length > 0) {
    const last = ctrl[ctrl.length - 1];
    out.push({ x: last.x, y: last.y });
  }
  return out;
}

function segmentsCross(a, b, c, d) {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) <= SMALL_NUMBER) {
    return null;
  }
  const cax = c.x - a.x;
  const cay = c.y - a.y;
  const t = (cax * sy - cay * sx) / denom;
  const u = (cax * ry - cay * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) {
    return null;
  }
  return { x: a.x + rx * t, y: a.y + ry * t };
}

/** Distance from P to a polyline; the closest point goes into out (if given). */
export function distanceToLine(line, px, py, out) {
  // Coarse pass over every 8th point finds roughly where the line is closest,
  // then an exact pass checks the segments around it
  const stride = 8;
  const window = 12;
  let roughIndex = 0;
  let roughDistSq = BIG;
  for (let i = 0; i < line.length; i += stride) {
    const dx = px - line[i].x;
    const dy = py - line[i].y;
    const d = dx * dx + dy * dy;
    if (d < roughDistSq) {
      roughDistSq = d;
      roughIndex = i;
    }
  }
  let best = BIG;
  let bestX = px;
  let bestY = py;
  const closest = { x: 0, y: 0 };
  const first = Math.max(roughIndex - window, 0);
  const last = Math.min(roughIndex + window, line.length - 1);
  for (let i = first; i < last; i++) {
    const d = distSqToSegment(px, py, line[i].x, line[i].y, line[i + 1].x, line[i + 1].y, closest);
    if (d < best) {
      best = d;
      bestX = closest.x;
      bestY = closest.y;
    }
  }
  if (out) {
    out.x = bestX;
    out.y = bestY;
  }
  return Math.sqrt(best);
}

export class ForestLayout {
  constructor(rules) {
    this.generate(rules);
  }

  generate(inRules) {
    const rules = {};
    for (const [key, value] of Object.entries(inRules)) {
      rules[key] = typeof value === 'number' && !INT_RULES.has(key) ? Math.fround(value) : value;
    }
    rules.TreeHeightMax = Math.max(rules.TreeHeightMax, rules.TreeHeightMin);
    rules.RockSizeMax = Math.max(rules.RockSizeMax, rules.RockSizeMin);
    this.rules = rules;

    const rand = new RandomStream(rules.Seed);
    this.hillNoiseOffset = { x: randBetween(rand, -500, 500), y: randBetween(rand, -500, 500) };
    this.clearingNoiseOffset = { x: randBetween(rand, -500, 500), y: randBetween(rand, -500, 500) };
    this.grassNoiseOffset = { x: randBetween(rand, -500, 500), y: randBetween(rand, -500, 500) };

    this.treeGridCell = 700;
    this.buildLines();
    this.findBridges();
    this.placePonds();
    this.placeBenches(); // also lays out the side paths, which the ground needs for its color
    this.buildGround();
    this.finishBridges();
    for (const bench of this.benches) {
      bench.z = this.groundZ(bench.x, bench.y);
    }
    this.scatterTrees();
    this.buildTreeGrid();
    this.scatterRocks();
    this.scatterGrass();
    this.scatterLogs();
    this.scatterFerns();
    this.scatterStreamStones();
    this.findPathStart();
  }

  halfSize() {
    return this.rules.PatchSize * 0.5;
  }

  areaScale() {
    const s = this.rules.PatchSize / 10000;
    return s * s;
  }

  lengthScale() {
    return this.rules.PatchSize / 10000;
  }

  /** Ground height at a position (interpolated from the grid). */
  groundZ(x, y) {
    const coords = this.gridCoords;
    const n = this.gridCount;
    if (n < 2) return 0;
    const x0 = findCell(coords, x);
    const y0 = findCell(coords, y);
    const tx = clamp((x - coords[x0]) / (coords[x0 + 1] - coords[x0]), 0, 1);
    const ty = clamp((y - coords[y0]) / (coords[y0 + 1] - coords[y0]), 0, 1);
    const h = this.heights;
    const z00 = h[y0 * n + x0];
    const z10 = h[y0 * n + x0 + 1];
    const z01 = h[(y0 + 1) * n + x0];
    const z11 = h[(y0 + 1) * n + x0 + 1];
    return lerp(lerp(z00, z10, tx), lerp(z01, z11, tx), ty);
  }

  /** Hills, valley and stream channel. */
  baseHeight(x, y) {
    const r = this.rules;
    const hills01 = fractalNoise(x / r.HillSize + this.hillNoiseOffset.x, y / r.HillSize + this.hillNoiseOffset.y, 4) * 0.5 + 0.5;
    let z = hills01 * r.HillHeight;
    // The land sinks toward the stream, so the stream runs along a valley floor
    const distToStream = distanceToLine(this.streamLine, x, y);
    const halfWidth = r.StreamWidth * 0.5;
    z *= smoothStep(halfWidth + r.StreamBankWidth, Math.max(r.ValleyWidth, halfWidth + r.StreamBankWidth + 1), distToStream);
    // Carve the stream channel
    const channel = 1 - smoothStep(halfWidth * 0.6, halfWidth + r.StreamBankWidth, distToStream);
    return lerp(z, -r.StreamDepth, channel);
  }

  /** baseHeight plus the pond basin (everything except the path). */
  rawHeight(x, y) {
    let z = this.baseHeight(x, y);
    const rimBlend = 400;
    for (const pond of this.ponds) {
      // Flat ring around the pond, then a smooth bowl below the water
      const d = distance(x, y, pond.x, pond.y);
      if (d > pond.radius + rimBlend) continue;
      const flatten = 1 - smoothStep(pond.radius, pond.radius + rimBlend, d);
      z = lerp(z, pond.rimZ, flatten);
      if (d < pond.radius) {
        const bowl = pond.rimZ - this.rules.PondDepth * (1 - smoothStep(0, pond.radius, d));
        z = Math.min(z, bowl);
      }
    }
    return z;
  }

  /** Distance to the nearest pond edge (negative inside the water); huge if there are no ponds. */
  distanceToPond(x, y) {
    let best = BIG;
    for (const pond of this.ponds) {
      best = Math.min(best, distance(x, y, pond.x, pond.y) - pond.radius);
    }
    return best;
  }

  isNearBench(x, y, d) {
    return this.benches.some((bench) => distance(x, y, bench.x, bench.y) < d);
  }

  isNearBridge(x, y, margin) {
    return this.bridges.some((bridge) => distance(x, y, bridge.x, bridge.y) < bridge.length * 0.5 + margin);
  }

  /** Distance from the nearest path edge (main path or side path); negative on the path. */
  distanceToPathEdge(x, y) {
    let edge = distanceToLine(this.pathLine, x, y) - this.rules.PathWidth * 0.5;
    for (const side of this.sideLines) {
      if (side.length > 1) {
        edge = Math.min(edge, distanceToLine(side, x, y) - this.rules.SidePathWidth * 0.5);
      }
    }
    return edge;
  }

  cellKey(cx, cy) {
    return (cx + 50000) * 100000 + (cy + 50000);
  }

  buildTreeGrid() {
    this.treeGrid = new Map();
    this.trees.forEach((tree, i) => {
      if (tree.backdrop) return;
      const key = this.cellKey(Math.floor(tree.x / this.treeGridCell), Math.floor(tree.y / this.treeGridCell));
      if (!this.treeGrid.has(key)) this.treeGrid.set(key, []);
      this.treeGrid.get(key).push(i);
    });
  }

  /** How much tree cover is above P (0 = open sky, 1 = under several trees). */
  treeCover(x, y, radius) {
    let cover = 0;
    const reach = Math.ceil(radius / this.treeGridCell);
    const cx = Math.floor(x / this.treeGridCell);
    const cy = Math.floor(y / this.treeGridCell);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const cell = this.treeGrid.get(this.cellKey(cx + dx, cy + dy));
        if (!cell) continue;
        for (const index of cell) {
          const tree = this.trees[index];
          const d = distance(x, y, tree.x, tree.y);
          if (d < radius) cover += 1 - d / radius;
        }
      }
    }
    return cover;
  }

  buildLines() {
    const r = this.rules;
    const rand = new RandomStream(partSeed(r.Seed, 1));
    const h = this.halfSize();
    const numCtrl = Math.max(7, roundToInt(Math.fround(r.PatchSize / Math.max(r.BendSpacing, 1000))) + 1);

    // Control point positions along the main direction: evenly across the walkable square,
    // plus a couple outside so the line keeps going through the outer margin
    const along = [];
    const reach = h + r.OuterMargin + 500;
    if (r.OuterMargin > 2000) {
      along.push(-reach, -h - r.OuterMargin * 0.5);
    }
    for (let i = 0; i < numCtrl; i++) {
      along.push(lerp(-h - 500, h + 500, i / (numCtrl - 1)));
    }
    if (r.OuterMargin > 2000) {
      along.push(h + r.OuterMargin * 0.5, reach);
    }

    // Stream: west to east, wandering in Y (more freely outside the square)
    const streamWander = Math.min(r.StreamWander, h * 0.6);
    let ctrl = along.map((x) => {
      const wander = Math.abs(x) > h + 500 ? streamWander * 1.5 : streamWander;
      return { x, y: randBetween(rand, -wander, wander) };
    });
    this.streamLine = sampleCurve(ctrl, 100);

    // Path: south to north, wandering in X, so it always crosses the stream
    const pathWander = Math.min(r.PathWander, h * 0.6);
    ctrl = along.map((y) => {
      const wander = Math.abs(y) > h + 500 ? pathWander * 1.5 : pathWander;
      return { x: randBetween(rand, -wander, wander), y };
    });
    this.pathLine = sampleCurve(ctrl, 100);
  }

  findBridges() {
    const r = this.rules;
    const path = this.pathLine;
    const stream = this.streamLine;
    this.bridges = [];
    for (let i = 0; i + 1 < path.length; i++) {
      for (let j = 0; j + 1 < stream.length; j++) {
        const cross = segmentsCross(path[i], path[i + 1], stream[j], stream[j + 1]);
        if (!cross) continue;
        if (Math.abs(cross.x) > this.halfSize() || Math.abs(cross.y) > this.halfSize()) continue;
        const pathDir = safeNormal(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
        const streamDir = safeNormal(stream[j + 1].x - stream[j].x, stream[j + 1].y - stream[j].y);
        // A crossing at a slant needs a longer bridge
        const sin = Math.max(Math.abs(pathDir.x * streamDir.y - pathDir.y * streamDir.x), 0.5);
        this.bridges.push({
          x: cross.x,
          y: cross.y,
          z: 0,
          dirX: pathDir.x,
          dirY: pathDir.y,
          yaw: radToDeg(Math.atan2(pathDir.y, pathDir.x)),
          pitch: 0,
          length: (r.StreamWidth + r.StreamBankWidth * 2 + 200) / sin,
          width: r.PathWidth + 60,
          thickness: 25,
        });
      }
    }
  }

  placePonds() {
    const r = this.rules;
    this.ponds = [];
    if (!r.bPond) return;
    const rand = new RandomStream(partSeed(r.Seed, 5));
    const h = this.halfSize();
    const radius = r.PondRadius;
    const edgeMargin = radius + 800;
    if (h <= edgeMargin) return;

    // Quiet spots: well away from the path, the stream, the bridges and each other
    const pathKeepOut = r.PathWidth * 0.5 + radius + 500;
    const streamKeepOut = r.StreamWidth * 0.5 + r.StreamBankWidth + radius + 600;
    const pondSpacing = radius * 4 + 3000;
    const candidates = [];
    const tries = 300 * Math.max(1, r.PondCount);
    for (let t = 0; t < tries; t++) {
      const x = randBetween(rand, -h + edgeMargin, h - edgeMargin);
      const y = randBetween(rand, -h + edgeMargin, h - edgeMargin);
      if (distanceToLine(this.pathLine, x, y) > pathKeepOut && distanceToLine(this.streamLine, x, y) > streamKeepOut
        && !this.isNearBridge(x, y, radius + 500)) {
        candidates.push({ x, y });
      }
    }
    for (const c of candidates) {
      if (this.ponds.length >= r.PondCount) break;
      if (!this.ponds.every((other) => distance(c.x, c.y, other.x, other.y) > pondSpacing)) continue;
      const rimZ = this.baseHeight(c.x, c.y);
      this.ponds.push({ x: c.x, y: c.y, radius, rimZ, waterZ: rimZ - 20 });
    }
  }

  placeBenches() {
    const r = this.rules;
    const path = this.pathLine;
    this.benches = [];
    this.sideLines = [];
    if (!r.bBench || path.length < 3) return;
    const h = this.halfSize();

    // The path point closest to P (inside the walkable area)
    const nearestPathIndex = (px, py) => {
      let best = -1;
      let bestDistSq = BIG;
      for (let i = 1; i + 1 < path.length; i++) {
        if (Math.abs(path[i].x) > h - 500 || Math.abs(path[i].y) > h - 500) continue;
        const dx = path[i].x - px;
        const dy = path[i].y - py;
        const d = dx * dx + dy * dy;
        if (d < bestDistSq) {
          bestDistSq = d;
          best = i;
        }
      }
      return best;
    };

    if (this.ponds.length === 0) {
      // No pond: one bench beside the path, 65% of the way north, facing it
      const index = nearestPathIndex(0, -h + r.PatchSize * 0.65);
      if (index < 0) return;
      const dir = safeNormal(path[index + 1].x - path[index - 1].x, path[index + 1].y - path[index - 1].y);
      const side = { x: -dir.y, y: dir.x };
      const x = path[index].x + side.x * (r.PathWidth * 0.5 + 80);
      const y = path[index].y + side.y * (r.PathWidth * 0.5 + 80);
      if (this.isNearBridge(x, y, 200) || distanceToLine(this.streamLine, x, y) < r.StreamWidth * 0.5 + r.StreamBankWidth + 100) return;
      this.benches.push({ x, y, z: 0, yaw: radToDeg(Math.atan2(-side.x, side.y)) });
      return;
    }

    for (const pond of this.ponds) {
      const index = nearestPathIndex(pond.x, pond.y);
      if (index < 0) continue;
      const onPath = path[index];

      // On the flat ground at the pond edge, on the path side, facing the water
      const toPond = safeNormal(pond.x - onPath.x, pond.y - onPath.y);
      const across = { x: -toPond.y, y: toPond.x };
      this.benches.push({
        x: pond.x - toPond.x * (pond.radius + 130),
        y: pond.y - toPond.y * (pond.radius + 130),
        z: 0,
        // The bench faces local -Y, so local +Y points away from the pond
        yaw: radToDeg(Math.atan2(toPond.x, -toPond.y)),
      });

      // Side path from the main path to just beside the bench, bending toward the middle
      const end = {
        x: pond.x - toPond.x * (pond.radius + 70) + across.x * 160,
        y: pond.y - toPond.y * (pond.radius + 70) + across.y * 160,
      };
      const halfway = { x: (onPath.x + end.x) * 0.5, y: (onPath.y + end.y) * 0.5 };
      const bendLength = distance(onPath.x, onPath.y, end.x, end.y) * 0.12;
      let bend = { x: across.x * bendLength, y: across.y * bendLength };
      if (bend.x * -halfway.x + bend.y * -halfway.y < 0) {
        bend = { x: -bend.x, y: -bend.y };
      }
      const side = sampleCurve([{ x: onPath.x, y: onPath.y }, { x: halfway.x + bend.x, y: halfway.y + bend.y }, end], 100);
      const limit = h - 300;
      for (const p of side) {
        p.x = clamp(p.x, -limit, limit);
        p.y = clamp(p.y, -limit, limit);
      }
      this.sideLines.push(side);
    }
  }

  buildGround() {
    const r = this.rules;
    // Grid lines: even spacing inside the walkable square, coarser further out
    const h = this.halfSize();
    const innerSteps = Math.max(1, roundToInt(Math.fround(r.PatchSize / r.GroundResolution)));
    const innerStep = Math.fround(r.PatchSize / innerSteps);
    const outerStepAt = (off) => {
      if (off < 2000) return Math.max(innerStep * 2, 100);
      if (off < 5000) return 200;
      if (off < 8000) return 400;
      if (off < 11000) return 800;
      return 1600;
    };
    const outerOffsets = [];
    let offset = 0;
    while (offset < r.OuterMargin - 1) {
      offset = Math.min(offset + outerStepAt(offset), r.OuterMargin);
      outerOffsets.push(offset);
    }
    const coords = [];
    for (let i = outerOffsets.length - 1; i >= 0; i--) coords.push(-h - outerOffsets[i]);
    for (let i = 0; i <= innerSteps; i++) coords.push(-h + i * innerStep);
    for (const outer of outerOffsets) coords.push(h + outer);
    this.gridCoords = coords;
    const n = coords.length;
    this.gridCount = n;
    this.waterZ = -r.StreamDepth * 0.45;

    this.heights = new Float32Array(n * n);
    this.pathWeight = new Float32Array(n * n);
    this.streamWeight = new Float32Array(n * n);
    const pathHalf = r.PathWidth * 0.5;
    const pathBlend = 150;
    const streamHalf = r.StreamWidth * 0.5;
    const onPath = { x: 0, y: 0 };

    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++) {
        const index = gy * n + gx;
        const x = coords[gx];
        const y = coords[gy];
        let z = this.rawHeight(x, y);
        const distToPath = distanceToLine(this.pathLine, x, y, onPath);
        const distToStream = distanceToLine(this.streamLine, x, y);

        // Flatten the ground across the path so it does not tilt sideways (not at bridges)
        if (!this.isNearBridge(onPath.x, onPath.y, 0)) {
          const flatten = 1 - smoothStep(pathHalf, pathHalf + pathBlend, distToPath);
          z = lerp(z, this.rawHeight(onPath.x, onPath.y), flatten);
        }

        let pathColor = 1 - smoothStep(pathHalf * 0.7, pathHalf + 40, distToPath);
        if (distToStream < streamHalf + r.StreamBankWidth) {
          pathColor = 0; // under the bridge
        }
        for (const side of this.sideLines) {
          const sideHalf = r.SidePathWidth * 0.5;
          pathColor = Math.max(pathColor, 1 - smoothStep(sideHalf * 0.6, sideHalf + 30, distanceToLine(side, x, y)));
        }

        // Muddy color on the stream bed and banks, and around the pond edge
        const streamMud = 1 - smoothStep(streamHalf, streamHalf + r.StreamBankWidth * 0.8, distToStream);
        const pondMud = 1 - smoothStep(-20, 80, this.distanceToPond(x, y));

        this.heights[index] = z;
        this.pathWeight[index] = pathColor;
        this.streamWeight[index] = Math.max(streamMud, pondMud);
      }
    }
  }

  finishBridges() {
    for (const bridge of this.bridges) {
      const hx = bridge.dirX * bridge.length * 0.5;
      const hy = bridge.dirY * bridge.length * 0.5;
      const zFront = Math.max(this.groundZ(bridge.x + hx, bridge.y + hy), this.waterZ + 30);
      const zBack = Math.max(this.groundZ(bridge.x - hx, bridge.y - hy), this.waterZ + 30);
      // Deck top sits a little above the ground at each end, sloping if the ends differ
      bridge.pitch = radToDeg(Math.atan2(zFront - zBack, bridge.length));
      bridge.z = (zFront + zBack) * 0.5 + 8 - bridge.thickness * 0.5;
    }
  }

  scatterTrees() {
    const r = this.rules;
    const rand = new RandomStream(partSeed(r.Seed, 2));
    const inside = this.halfSize();
    // Sample the walkable square plus the backdrop band around it
    const h = inside + r.BackdropWidth;
    const minDist = r.TreeSpacing;

    // Poisson-disk sampling: random spots that are never closer than minDist
    const cellSize = minDist / Math.SQRT2;
    const cells = Math.max(1, Math.ceil((h * 2) / cellSize));
    const cellGrid = new Int32Array(cells * cells).fill(-1);
    const points = [];
    const active = [];
    const cellOf = (x, y) => [
      clamp(Math.floor((x + h) / cellSize), 0, cells - 1),
      clamp(Math.floor((y + h) / cellSize), 0, cells - 1),
    ];
    const fits = (x, y) => {
      if (Math.abs(x) > h || Math.abs(y) > h) return false;
      const [cx0, cy0] = cellOf(x, y);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const cx = cx0 + dx;
          const cy = cy0 + dy;
          if (cx < 0 || cy < 0 || cx >= cells || cy >= cells) continue;
          const other = cellGrid[cy * cells + cx];
          if (other >= 0) {
            const ox = x - points[other].x;
            const oy = y - points[other].y;
            if (ox * ox + oy * oy < minDist * minDist) return false;
          }
        }
      }
      return true;
    };
    const addPoint = (x, y) => {
      const index = points.push({ x, y }) - 1;
      const [cx, cy] = cellOf(x, y);
      cellGrid[cy * cells + cx] = index;
      active.push(index);
    };

    {
      const x = randBetween(rand, -h, h);
      const y = randBetween(rand, -h, h);
      addPoint(x, y);
    }
    while (active.length > 0) {
      const slot = rand.randRange(0, active.length - 1);
      const from = points[active[slot]];
      let found = false;
      for (let t = 0; t < 30; t++) {
        const angle = randBetween(rand, 0, 2 * Math.PI);
        const d = randBetween(rand, minDist, minDist * 2);
        const x = from.x + Math.cos(angle) * d;
        const y = from.y + Math.sin(angle) * d;
        if (fits(x, y)) {
          addPoint(x, y);
          found = true;
          break;
        }
      }
      if (!found) {
        active[slot] = active[active.length - 1]; // remove by swapping in the last one
        active.pop();
      }
    }
    this.treeCandidates = points;

    // Keep trees off the path, out of the stream and away from bridges and ponds
    const streamKeepOut = r.StreamWidth * 0.5 + r.StreamBankWidth + r.TreeClearance;
    const kept = [];
    const clearingNoise = [];
    for (const p of points) {
      if (this.distanceToPathEdge(p.x, p.y) < r.TreeClearance || distanceToLine(this.streamLine, p.x, p.y) < streamKeepOut
        || this.isNearBridge(p.x, p.y, 200) || this.distanceToPond(p.x, p.y) < r.TreeClearance + 100) {
        continue;
      }
      kept.push(p);
      clearingNoise.push(fractalNoise(p.x / 2500 + this.clearingNoiseOffset.x, p.y / 2500 + this.clearingNoiseOffset.y, 2));
    }

    // Clearings: drop the spots where the clearing noise is highest
    let threshold = BIG;
    if (r.ClearingAmount > 0 && clearingNoise.length > 0) {
      const sorted = [...clearingNoise].sort((a, b) => a - b);
      const cut = clamp(Math.floor((1 - r.ClearingAmount) * sorted.length), 0, sorted.length - 1);
      threshold = sorted[cut];
    }

    this.trees = [];
    kept.forEach((p, i) => {
      if (clearingNoise[i] >= threshold) return;
      const height = randBetween(rand, r.TreeHeightMin, r.TreeHeightMax);
      const trunkRadius = height * randBetween(rand, 0.01, 0.014);
      const yaw = randBetween(rand, 0, 360);
      const slenderness = randBetween(rand, 0.8, 1.15);
      const broadleaf = rand.fraction() < r.BroadleafRatio;
      this.trees.push({
        x: p.x,
        y: p.y,
        z: this.groundZ(p.x, p.y),
        height,
        trunkRadius,
        yaw,
        slenderness,
        broadleaf,
        backdrop: Math.abs(p.x) > inside + r.EdgeDetailWidth || Math.abs(p.y) > inside + r.EdgeDetailWidth,
      });
    });
  }

  scatterRocks() {
    const r = this.rules;
    const rand = new RandomStream(partSeed(r.Seed, 3));
    const h = this.halfSize();
    const streamHalf = r.StreamWidth * 0.5;
    const rockTotal = roundToInt(r.RockCount * this.areaScale());
    const streamRocks = roundToInt(rockTotal * r.RockStreamShare);
    const stream = this.streamLine;

    // Stream points that lie inside the patch
    const streamInside = [];
    for (let i = 0; i + 1 < stream.length; i++) {
      if (Math.abs(stream[i].x) < h - 200 && Math.abs(stream[i].y) < h - 200) streamInside.push(i);
    }

    this.rocks = [];
    for (let rockIndex = 0; rockIndex < rockTotal; rockIndex++) {
      const byStream = rockIndex < streamRocks && streamInside.length > 0;
      let px = 0;
      let py = 0;
      let placed = false;
      for (let t = 0; t < 10 && !placed; t++) {
        if (byStream) {
          // In the water or on the banks
          const seg = streamInside[rand.randRange(0, streamInside.length - 1)];
          const dir = safeNormal(stream[seg + 1].x - stream[seg].x, stream[seg + 1].y - stream[seg].y);
          const offset = randBetween(rand, 0, streamHalf + r.StreamBankWidth + 80);
          const signed = rand.fraction() < 0.5 ? -offset : offset;
          px = stream[seg].x - dir.y * signed;
          py = stream[seg].y + dir.x * signed;
        } else {
          px = randBetween(rand, -h, h);
          py = randBetween(rand, -h, h);
        }
        placed = Math.abs(px) < h && Math.abs(py) < h
          && this.distanceToPathEdge(px, py) > 30
          && !this.isNearBridge(px, py, 100)
          && this.distanceToPond(px, py) > 50
          && !this.isNearBench(px, py, 250);
      }
      if (!placed) continue;

      // Mostly small rocks, a few big ones
      const pick = rand.fraction();
      let size = lerp(r.RockSizeMin, r.RockSizeMax, pick * pick);
      if (byStream) size *= 0.7;
      const sx = (size * randBetween(rand, 0.9, 1.3)) / 100;
      const sy = (size * randBetween(rand, 0.7, 1.0)) / 100;
      const sz = (size * randBetween(rand, 0.4, 0.7)) / 100;
      const pitch = randBetween(rand, -15, 15);
      const yaw = randBetween(rand, 0, 360);
      const roll = randBetween(rand, -15, 15);
      // Sink the rock a bit so it looks embedded
      this.rocks.push({ x: px, y: py, z: this.groundZ(px, py) - sz * 100 * 0.2, sx, sy, sz, pitch, yaw, roll });
    }

    // A few stones around each pond edge
    for (const pond of this.ponds) {
      for (let i = 0; i < 9; i++) {
        const angle = randBetween(rand, 0, 2 * Math.PI);
        const d = pond.radius * randBetween(rand, 0.9, 1.15);
        const px = pond.x + Math.cos(angle) * d;
        const py = pond.y + Math.sin(angle) * d;
        const size = randBetween(rand, 35, 90);
        if (this.isNearBench(px, py, 200) || this.distanceToPathEdge(px, py) < 30) continue; // keep the bench and side path clear
        const sx = (size * randBetween(rand, 0.9, 1.3)) / 100;
        const sy = (size * randBetween(rand, 0.7, 1.0)) / 100;
        const sz = (size * randBetween(rand, 0.4, 0.6)) / 100;
        const pitch = randBetween(rand, -10, 10);
        const yaw = randBetween(rand, 0, 360);
        const roll = randBetween(rand, -10, 10);
        this.rocks.push({ x: px, y: py, z: this.groundZ(px, py) - sz * 100 * 0.25, sx, sy, sz, pitch, yaw, roll });
      }
    }
  }

  scatterGrass() {
    const r = this.rules;
    const rand = new RandomStream(partSeed(r.Seed, 4));
    const h = this.halfSize() + r.EdgeDetailWidth; // walkable square plus the edge band
    const step = r.GrassSpacing;
    const count = Math.floor((h * 2) / step);
    const streamKeepOut = r.StreamWidth * 0.5 + 20;
    const shadeRadius = 600;
    const inside = this.halfSize();

    this.grass = [];
    for (let gy = 0; gy < count; gy++) {
      for (let gx = 0; gx < count; gx++) {
        // Jittered grid so tufts do not line up (the C++ adds the jitter in 32-bit floats)
        const x = -h + Math.fround(gx + rand.fraction()) * step;
        const y = -h + Math.fround(gy + rand.fraction()) * step;
        if (this.distanceToPathEdge(x, y) < 10 || distanceToLine(this.streamLine, x, y) < streamKeepOut || this.distanceToPond(x, y) < 30) {
          continue;
        }
        // Tree cover thins the grass; some areas are grassier than others
        const cover = clamp(this.treeCover(x, y, shadeRadius) / 1.5, 0, 1);
        const patch = clamp(0.6 + 0.8 * fractalNoise(x / 800 + this.grassNoiseOffset.x, y / 800 + this.grassNoiseOffset.y, 2), 0, 1);
        const edgeBand = Math.abs(x) > inside || Math.abs(y) > inside ? 0.5 : 1;
        const chance = r.GrassDensity * (1 - r.GrassShade * cover) * patch * edgeBand;
        if (rand.fraction() >= chance) continue;
        const scale = randBetween(rand, 0.7, 1.4);
        const yaw = randBetween(rand, 0, 360);
        this.grass.push({ x, y, z: this.groundZ(x, y), scale, yaw });
      }
    }
  }

  scatterLogs() {
    const r = this.rules;
    const rand = new RandomStream(partSeed(r.Seed, 6));
    const h = this.halfSize() - 300;
    const streamKeepOut = r.StreamWidth * 0.5 + r.StreamBankWidth + 80;

    this.logs = [];
    const logTotal = roundToInt(r.FallenLogCount * this.areaScale());
    for (let logIndex = 0; logIndex < logTotal; logIndex++) {
      for (let t = 0; t < 20; t++) {
        const cx = randBetween(rand, -h, h);
        const cy = randBetween(rand, -h, h);
        const yaw = randBetween(rand, 0, 360);
        const length = randBetween(rand, 300, 800);
        const radius = randBetween(rand, 15, 32);
        const dx = Math.cos(degToRad(yaw));
        const dy = Math.sin(degToRad(yaw));
        const a = { x: cx - dx * length * 0.5, y: cy - dy * length * 0.5 };
        const b = { x: cx + dx * length * 0.5, y: cy + dy * length * 0.5 };

        let fitsHere = true;
        for (const p of [a, { x: cx, y: cy }, b]) {
          if (Math.abs(p.x) > h || Math.abs(p.y) > h
            || this.distanceToPathEdge(p.x, p.y) < 150
            || distanceToLine(this.streamLine, p.x, p.y) < streamKeepOut
            || this.distanceToPond(p.x, p.y) < 150
            || this.isNearBridge(p.x, p.y, 200)
            || this.isNearBench(p.x, p.y, 300)) {
            fitsHere = false;
            break;
          }
        }
        // Do not run through standing trees
        for (let i = 0; fitsHere && i < this.trees.length; i++) {
          const tree = this.trees[i];
          const gap = tree.trunkRadius + radius + 40;
          if (!tree.backdrop && distSqToSegment(tree.x, tree.y, a.x, a.y, b.x, b.y, null) < gap * gap) {
            fitsHere = false;
          }
        }
        if (!fitsHere) continue;

        // Lie along the ground: tilt to follow the slope between the two ends
        const za = this.groundZ(a.x, a.y);
        const zb = this.groundZ(b.x, b.y);
        const slope = radToDeg(Math.atan2(za - zb, length));
        this.logs.push({
          x: cx,
          y: cy,
          z: (za + zb) * 0.5 + radius * 0.7,
          length,
          radius,
          pitch: 90 - slope, // turns a standing cylinder so it lies along the ground
          yaw,
        });
        break;
      }
    }
  }

  scatterFerns() {
    const r = this.rules;
    const rand = new RandomStream(partSeed(r.Seed, 7));
    const h = this.halfSize() + r.EdgeDetailWidth;
    const step = r.FernSpacing;
    const count = Math.floor((h * 2) / step);
    const streamHalf = r.StreamWidth * 0.5;
    const bankEdge = streamHalf + r.StreamBankWidth;
    const shadeRadius = 700;
    const inside = this.halfSize();

    this.ferns = [];
    for (let gy = 0; gy < count; gy++) {
      for (let gx = 0; gx < count; gx++) {
        const x = -h + Math.fround(gx + rand.fraction()) * step;
        const y = -h + Math.fround(gy + rand.fraction()) * step;
        const distToStream = distanceToLine(this.streamLine, x, y);
        const distToPond = this.distanceToPond(x, y);
        if (this.distanceToPathEdge(x, y) < 40 || distToStream < streamHalf + 30 || distToPond < 20 || this.isNearBridge(x, y, 100)
          || this.isNearBench(x, y, 150)) {
          continue;
        }
        // Ferns like shade and damp ground near water
        const cover = clamp(this.treeCover(x, y, shadeRadius) / 1.5, 0, 1);
        const damp = Math.max(1 - smoothStep(bankEdge, bankEdge + 600, distToStream), 1 - smoothStep(0, 500, distToPond));
        const edgeBand = Math.abs(x) > inside || Math.abs(y) > inside ? 0.5 : 1;
        const chance = r.FernDensity * clamp(0.05 + 0.5 * cover + 0.6 * damp, 0, 1) * edgeBand;
        if (rand.fraction() >= chance) continue;
        const size = randBetween(rand, 0.7, 1.4);
        const yaw = randBetween(rand, 0, 360);
        this.ferns.push({ x, y, z: this.groundZ(x, y), size, yaw });
      }
    }
  }

  scatterStreamStones() {
    const r = this.rules;
    const rand = new RandomStream(partSeed(r.Seed, 8));
    const h = this.halfSize();
    const streamHalf = r.StreamWidth * 0.5;
    const stream = this.streamLine;

    // Stream points inside the walkable square (plus a little beyond, for the view)
    const inside = [];
    for (let i = 0; i + 1 < stream.length; i++) {
      if (Math.abs(stream[i].x) < h + 1000 && Math.abs(stream[i].y) < h + 1000) inside.push(i);
    }
    this.streamStones = [];
    if (inside.length === 0) return;
    const stoneTotal = roundToInt(r.StreamStoneCount * this.lengthScale());
    for (let s = 0; s < stoneTotal; s++) {
      const seg = inside[rand.randRange(0, inside.length - 1)];
      const dir = safeNormal(stream[seg + 1].x - stream[seg].x, stream[seg + 1].y - stream[seg].y);
      // Most stones near the water's edge, where they poke out of the water
      const across = rand.fraction() < 0.6 ? randBetween(rand, 0.6, 1.15) : randBetween(rand, 0, 0.6);
      const sideSign = rand.fraction() < 0.5 ? -1 : 1;
      const along = randBetween(rand, 0, 100);
      const sideAmount = streamHalf * across * sideSign;
      const x = stream[seg].x + dir.x * along - dir.y * sideAmount;
      const y = stream[seg].y + dir.y * along + dir.x * sideAmount;
      const pick = rand.fraction();
      const size = lerp(10, 40, pick * pick);
      const sx = (size * randBetween(rand, 0.9, 1.3)) / 100;
      const sy = (size * randBetween(rand, 0.7, 1.0)) / 100;
      const sz = (size * randBetween(rand, 0.35, 0.55)) / 100;
      const yaw = randBetween(rand, 0, 360);
      this.streamStones.push({ x, y, z: this.groundZ(x, y) - sz * 100 * 0.15, sx, sy, sz, pitch: 0, yaw, roll: 0 });
    }
  }

  findPathStart() {
    const h = this.halfSize();
    let start = { x: 0, y: -h + 500 };
    for (const p of this.pathLine) {
      if (p.y > -h + 500) {
        start = { x: p.x, y: p.y };
        break;
      }
    }
    this.pathStart = { x: start.x, y: start.y, z: this.groundZ(start.x, start.y) + 120 };
  }
}
