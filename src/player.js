// The player: how it walks, jumps and bumps into things, and the stand-in figure that shows it.
// Movement works in Unreal units (cm, X/Y on the ground, Z up) like the layout, with the
// numbers of the Unreal character (AForestCharacter / CharacterMovement).

import * as THREE from 'three';
import { CM } from './world.js';

export const MOVE = {
  capsuleRadius: 42,
  capsuleHalfHeight: 96,
  maxSpeed: 500, // cm/s at full stick
  minSpeed: 20,
  acceleration: 2048,
  braking: 2000,
  brakingFalling: 1500,
  airControl: 0.35,
  jumpSpeed: 500,
  gravity: 980,
  maxStep: 45, // can step up this much (logs, rocks, the bridge)
  turnRate: 500, // degrees per second, turning toward where it walks
  climbSpeed: 160, // up and down a trunk, cm/s
  climbAroundSpeed: 140, // around a trunk, cm/s
  climbReach: 80, // how far from the body a trunk can be grabbed
  jumpOffSpeed: 500, // pushing away from the trunk
  jumpOffUp: 350,
  brakingAfterJumpOff: 150, // weak air braking until landing, so the push carries
};

const FOOT_SAMPLES = [[0, 0], [22, 0], [-22, 0], [0, 22], [0, -22]];
const CELL = 400;

/** Things to stand on (rocks, logs, bridges, benches), as "how high is the top here?". */
function buildSurfaces(layout) {
  const surfaces = [];
  for (const rock of layout.rocks) {
    // A squashed sphere turned by its yaw (the small tilts are ignored)
    const yaw = THREE.MathUtils.degToRad(rock.yaw);
    surfaces.push({
      reach: Math.max(rock.sx, rock.sy) * 50,
      x: rock.x,
      y: rock.y,
      top(px, py) {
        const dx = px - rock.x;
        const dy = py - rock.y;
        const u = (dx * Math.cos(yaw) + dy * Math.sin(yaw)) / (rock.sx * 50);
        const v = (-dx * Math.sin(yaw) + dy * Math.cos(yaw)) / (rock.sy * 50);
        const k = 1 - u * u - v * v;
        return k > 0 ? rock.z + rock.sz * 50 * Math.sqrt(k) : -Infinity;
      },
    });
  }
  for (const log of layout.logs) {
    const yaw = THREE.MathUtils.degToRad(log.yaw);
    const dirX = Math.cos(yaw);
    const dirY = Math.sin(yaw);
    const tilt = Math.tan(THREE.MathUtils.degToRad(90 - log.pitch)); // the slope it lies on
    surfaces.push({
      reach: log.length * 0.5 + log.radius,
      x: log.x,
      y: log.y,
      top(px, py) {
        const dx = px - log.x;
        const dy = py - log.y;
        const t = dx * dirX + dy * dirY;
        const d = -dx * dirY + dy * dirX;
        if (Math.abs(t) > log.length * 0.5 || Math.abs(d) >= log.radius) return -Infinity;
        return log.z - t * tilt + Math.sqrt(log.radius * log.radius - d * d);
      },
    });
  }
  for (const bridge of layout.bridges) {
    const slope = Math.tan(THREE.MathUtils.degToRad(bridge.pitch));
    surfaces.push({
      reach: bridge.length * 0.5 + bridge.width,
      x: bridge.x,
      y: bridge.y,
      top(px, py) {
        const dx = px - bridge.x;
        const dy = py - bridge.y;
        const u = dx * bridge.dirX + dy * bridge.dirY;
        const v = -dx * bridge.dirY + dy * bridge.dirX;
        if (Math.abs(u) > bridge.length * 0.5 || Math.abs(v) > bridge.width * 0.5) return -Infinity;
        return bridge.z + u * slope + bridge.thickness * 0.5;
      },
    });
  }
  for (const bench of layout.benches) {
    // Seat and backrest (the legs are under the seat)
    const yaw = THREE.MathUtils.degToRad(bench.yaw);
    const boxes = [[0, 0, 45, 160, 45, 6], [0, 20, 75, 160, 5, 40]];
    surfaces.push({
      reach: 100,
      x: bench.x,
      y: bench.y,
      top(px, py) {
        const dx = px - bench.x;
        const dy = py - bench.y;
        const u = dx * Math.cos(yaw) + dy * Math.sin(yaw);
        const v = -dx * Math.sin(yaw) + dy * Math.cos(yaw);
        let best = -Infinity;
        for (const [cx, cy, cz, sx, sy, sz] of boxes) {
          if (Math.abs(u - cx) <= sx * 0.5 && Math.abs(v - cy) <= sy * 0.5) best = Math.max(best, bench.z + cz + sz * 0.5);
        }
        return best;
      },
    });
  }
  return surfaces;
}

/** Puts things into a coarse grid, so only nearby ones are checked. */
class Buckets {
  constructor(items, reachOf) {
    this.map = new Map();
    for (const item of items) {
      const r = reachOf(item);
      for (let cx = Math.floor((item.x - r) / CELL); cx <= Math.floor((item.x + r) / CELL); cx++) {
        for (let cy = Math.floor((item.y - r) / CELL); cy <= Math.floor((item.y + r) / CELL); cy++) {
          const key = cx * 100000 + cy;
          if (!this.map.has(key)) this.map.set(key, []);
          this.map.get(key).push(item);
        }
      }
    }
  }

  near(x, y) {
    return this.map.get(Math.floor(x / CELL) * 100000 + Math.floor(y / CELL)) ?? [];
  }
}

export class PlayerMovement {
  constructor(layout, trunks) {
    this.layout = layout;
    // Trees that can be climbed: every tree in the walkable area, up to a part of its height
    this.climbable = [];
    layout.trees.forEach((tree, index) => {
      if (tree.backdrop) return;
      this.climbable.push({
        index,
        x: tree.x,
        y: tree.y,
        z: tree.z,
        radius: tree.trunkRadius,
        top: tree.height * (tree.broadleaf ? 0.55 : 0.8),
      });
    });
    this.trunks = new Buckets(trunks, (t) => t.radius + MOVE.capsuleRadius);
    this.surfaces = new Buckets(buildSurfaces(layout), (s) => s.reach + 30);
    this.edge = layout.halfSize() - MOVE.capsuleRadius; // the invisible walls at the walkable edge
    this.reset();
  }

  reset(x = this.layout.pathStart.x, y = this.layout.pathStart.y, yaw = 90) {
    this.x = x;
    this.y = y;
    this.z = this.floorAt(x, y); // feet
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.grounded = true;
    this.yaw = yaw; // facing, Unreal degrees (90 = north, along +Y)
    this.distance = 0;
    this.climbing = null; // the trunk being climbed
    this.climbHeight = 0; // feet above the trunk base
    this.climbAngle = 0; // where around the trunk (radians)
    this.climbCycle = 0; // arm and leg cycle for the climbing pose
    this.jumpedOff = false;
  }

  /** The nearest trunk within reach, or null. */
  trunkInReach() {
    let best = null;
    let bestGap = MOVE.capsuleRadius + MOVE.climbReach;
    for (const trunk of this.climbable) {
      const gap = Math.hypot(this.x - trunk.x, this.y - trunk.y) - trunk.radius;
      if (gap <= bestGap) {
        bestGap = gap;
        best = trunk;
      }
    }
    return best;
  }

  /** Grab the nearest trunk (E key / climb button). Returns true if climbing started. */
  startClimb() {
    const trunk = this.climbing ? null : this.trunkInReach();
    if (!trunk) return false;
    this.climbing = trunk;
    this.climbHeight = THREE.MathUtils.clamp(this.z - trunk.z, 0, trunk.top);
    this.climbAngle = Math.atan2(this.y - trunk.y, this.x - trunk.x);
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.grounded = false;
    this.climbStep(0, 0, 0);
    return true;
  }

  /** Let go (falls), or jump off pushing away from the trunk. */
  stopClimb(jumpOff) {
    const trunk = this.climbing;
    if (!trunk) return;
    this.climbing = null;
    this.grounded = false;
    if (jumpOff) {
      const dx = this.x - trunk.x;
      const dy = this.y - trunk.y;
      const d = Math.hypot(dx, dy) || 1;
      this.vx = (dx / d) * MOVE.jumpOffSpeed;
      this.vy = (dy / d) * MOVE.jumpOffSpeed;
      this.vz = MOVE.jumpOffUp;
      this.jumpedOff = true;
    }
  }

  /** While climbing: up = forward on the stick, around = right / left. */
  climbStep(dt, right, forward) {
    const trunk = this.climbing;
    const distance = trunk.radius + MOVE.capsuleRadius + 4;
    const oldHeight = this.climbHeight;
    this.climbHeight = THREE.MathUtils.clamp(this.climbHeight + forward * MOVE.climbSpeed * dt, 0, trunk.top);
    // Facing the trunk, moving right goes clockwise around it
    this.climbAngle -= right * (MOVE.climbAroundSpeed / distance) * dt;
    const moved = Math.abs(this.climbHeight - oldHeight) + Math.abs(right) * MOVE.climbAroundSpeed * dt;
    this.climbCycle += moved / 90; // arms and legs: about 90 cm per left+right cycle
    this.x = trunk.x + Math.cos(this.climbAngle) * distance;
    this.y = trunk.y + Math.sin(this.climbAngle) * distance;
    this.z = trunk.z + this.climbHeight;
    this.yaw = (THREE.MathUtils.radToDeg(this.climbAngle) + 180 + 360) % 360;
    this.distance += moved;
    // Climbing down to the ground puts the feet back on it
    if (this.climbHeight <= 0.5 && forward < 0) this.stopClimb(false);
  }

  /** Height of whatever is under one point: the ground, or a rock / log / bridge / bench on it. */
  topAt(px, py) {
    let top = this.layout.groundZ(px, py);
    for (const surface of this.surfaces.near(px, py)) top = Math.max(top, surface.top(px, py));
    return top;
  }

  /** Floor under the feet (a few points around the middle of the body). */
  floorAt(x, y) {
    let floor = -Infinity;
    for (const [ox, oy] of FOOT_SAMPLES) floor = Math.max(floor, this.topAt(x + ox, y + oy));
    return floor;
  }

  canStandAt(x, y) {
    if (Math.abs(x) > this.edge || Math.abs(y) > this.edge) return false;
    const floor = this.floorAt(x, y);
    // On the ground it can step up a little; in the air it cannot move into something taller
    return floor <= this.z + (this.grounded ? MOVE.maxStep : 2);
  }

  /** Pushes the body out of tree trunks; returns true if it touched one. */
  pushOutOfTrunks() {
    let touched = false;
    for (const trunk of this.trunks.near(this.x, this.y)) {
      if (this.z > trunk.top) continue;
      const dx = this.x - trunk.x;
      const dy = this.y - trunk.y;
      const d = Math.hypot(dx, dy);
      const min = trunk.radius + MOVE.capsuleRadius;
      if (d >= min || d === 0) continue;
      const nx = dx / d;
      const ny = dy / d;
      this.x = trunk.x + nx * min;
      this.y = trunk.y + ny * min;
      // Keep only the part of the speed that slides along the trunk
      const into = this.vx * nx + this.vy * ny;
      if (into < 0) {
        this.vx -= into * nx;
        this.vy -= into * ny;
      }
      touched = true;
    }
    return touched;
  }

  /**
   * One step of movement. dirX/dirY: where the stick points on the ground (length 0..1),
   * jump: the jump button was pressed.
   */
  step(dt, dirX, dirY, jump, climbInput = null) {
    if (this.climbing) {
      // Jump pushes off the trunk; otherwise the stick climbs (given relative to the body)
      if (jump) this.stopClimb(true);
      else this.climbStep(dt, climbInput?.x ?? 0, climbInput?.y ?? 0);
      return;
    }
    let amount = Math.hypot(dirX, dirY);
    if (amount > 1) {
      dirX /= amount;
      dirY /= amount;
      amount = 1;
    }
    const targetSpeed = amount > 0.05 ? Math.max(MOVE.minSpeed, MOVE.maxSpeed * amount) : 0;
    const targetX = amount > 0.05 ? (dirX / amount) * targetSpeed : 0;
    const targetY = amount > 0.05 ? (dirY / amount) * targetSpeed : 0;

    // Speed up toward where the stick points, or slow down when it is let go
    const fallingBraking = this.jumpedOff ? MOVE.brakingAfterJumpOff : MOVE.brakingFalling;
    const accel = targetSpeed > 0
      ? MOVE.acceleration * (this.grounded ? 1 : MOVE.airControl)
      : (this.grounded ? MOVE.braking : fallingBraking);
    const ddx = targetX - this.vx;
    const ddy = targetY - this.vy;
    const gap = Math.hypot(ddx, ddy);
    const change = Math.min(gap, accel * dt);
    if (gap > 0) {
      this.vx += (ddx / gap) * change;
      this.vy += (ddy / gap) * change;
    }

    if (jump && this.grounded) {
      this.vz = MOVE.jumpSpeed;
      this.grounded = false;
    }

    // Move across the ground, sliding along whatever blocks the way
    const startX = this.x;
    const startY = this.y;
    const nx = this.x + this.vx * dt;
    const ny = this.y + this.vy * dt;
    if (this.canStandAt(nx, ny)) {
      this.x = nx;
      this.y = ny;
    } else if (this.canStandAt(nx, this.y)) {
      this.x = nx;
      this.vy = 0;
    } else if (this.canStandAt(this.x, ny)) {
      this.y = ny;
      this.vx = 0;
    } else {
      this.vx = 0;
      this.vy = 0;
    }
    this.pushOutOfTrunks();
    this.x = THREE.MathUtils.clamp(this.x, -this.edge, this.edge);
    this.y = THREE.MathUtils.clamp(this.y, -this.edge, this.edge);
    this.distance += Math.hypot(this.x - startX, this.y - startY);

    // Up and down: follow the floor while walking, fall when it drops away or after a jump
    const floor = this.floorAt(this.x, this.y);
    if (this.grounded) {
      if (floor >= this.z - MOVE.maxStep) {
        this.z = floor;
      } else {
        this.grounded = false; // walked off an edge (the bridge, a log, the bench)
        this.vz = 0;
      }
    }
    if (!this.grounded) {
      this.vz -= MOVE.gravity * dt;
      this.z += this.vz * dt;
      if (this.z <= floor) {
        this.z = floor;
        this.vz = 0;
        this.grounded = true;
        this.jumpedOff = false;
      }
    }

    // Turn to face where it is going
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > 10 && amount > 0.05) {
      const want = THREE.MathUtils.radToDeg(Math.atan2(this.vy, this.vx));
      let diff = ((want - this.yaw + 540) % 360) - 180;
      const turn = MOVE.turnRate * dt;
      diff = THREE.MathUtils.clamp(diff, -turn, turn);
      this.yaw = (this.yaw + diff + 360) % 360;
    }
  }

  get speed() {
    return Math.hypot(this.vx, this.vy);
  }
}

/** A plain stand-in person (about 175 cm), built from capsules, with a simple walk. */
export function buildFigure() {
  const material = new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(0.42, 0.44, 0.48) });
  const part = (radius, length, x, y, z) => {
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 3, 8), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    return mesh;
  };
  const root = new THREE.Group(); // at the feet, facing +X
  const body = new THREE.Group();
  root.add(body);
  body.add(part(0.15, 0.36, 0, 1.2, 0)); // chest and belly
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 10), material);
  head.position.set(0.01, 1.61, 0);
  head.castShadow = true;
  body.add(head);

  const limb = (x, y, z, radius, length) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    pivot.add(part(radius, length, 0, -(length * 0.5 + radius), 0));
    body.add(pivot);
    return pivot;
  };
  const legL = limb(0, 0.9, 0.1, 0.075, 0.7);
  const legR = limb(0, 0.9, -0.1, 0.075, 0.7);
  const armL = limb(0, 1.42, 0.22, 0.055, 0.52);
  const armR = limb(0, 1.42, -0.22, 0.055, 0.52);

  let phase = 0;
  return {
    root,
    /** Moves the figure to the player and swings the arms and legs. */
    update(player, dt) {
      root.position.set(player.x * CM, player.z * CM, player.y * CM);
      root.rotation.y = -THREE.MathUtils.degToRad(player.yaw);
      const speed = player.speed;
      let swing = 0;
      if (player.grounded) {
        phase += (speed * dt) / 130; // one stride per ~1.3 m
        swing = Math.min(speed / 300, 1) * 0.6;
      }
      const s = Math.sin(phase * Math.PI);
      // Rotating about Z swings forward/back (the figure faces +X)
      legL.rotation.z = s * swing;
      legR.rotation.z = -s * swing;
      armL.rotation.z = -s * swing * 0.8;
      armR.rotation.z = s * swing * 0.8;
      if (!player.grounded) {
        // In the air: one knee up, arms out a little
        legL.rotation.z = 0.5;
        legR.rotation.z = -0.15;
        armL.rotation.x = -0.35;
        armR.rotation.x = 0.35;
      } else {
        armL.rotation.x = -0.08;
        armR.rotation.x = 0.08;
      }
      body.position.y = player.grounded ? Math.abs(Math.cos(phase * Math.PI)) * 0.03 * Math.min(speed / 300, 1) : 0;
    },
  };
}
