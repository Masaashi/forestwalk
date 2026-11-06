// The camera behind the player, like the Unreal camera boom: 4 m back from the middle of the
// body, turned by the player's look input, pulled in front of a trunk or the ground in the way.

import * as THREE from 'three';
import { CM } from './world.js';
import { MOVE } from './player.js';

const ARM_LENGTH = 400; // cm
const PROBE = 15; // keep this far from trunks and the ground

export class FollowCamera {
  constructor(camera, layout, trunks) {
    this.camera = camera;
    this.layout = layout;
    this.trunks = trunks;
    this.yaw = 90; // Unreal degrees, like the player
    this.pitch = -15;
    this.arm = ARM_LENGTH;
  }

  addLook(dYaw, dPitch) {
    this.yaw = (this.yaw + dYaw + 360) % 360;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dPitch, -70, 35);
  }

  /** Ground directions for the stick: forward and right of the camera (Unreal x/y). */
  directions() {
    const yaw = THREE.MathUtils.degToRad(this.yaw);
    return { forwardX: Math.cos(yaw), forwardY: Math.sin(yaw), rightX: -Math.sin(yaw), rightY: Math.cos(yaw) };
  }

  /** Is this spot (Unreal cm) clear for the camera? (Ground, rocks, logs, bridges and trunks block it.) */
  clear(player, x, y, z) {
    if (z < player.topAt(x, y) + PROBE) return false;
    for (const trunk of this.trunks) {
      if (z > trunk.top) continue;
      const dx = x - trunk.x;
      const dy = y - trunk.y;
      if (dx * dx + dy * dy < (trunk.radius + PROBE) ** 2) return false;
    }
    return true;
  }

  update(player, dt) {
    const yaw = THREE.MathUtils.degToRad(this.yaw);
    const pitch = THREE.MathUtils.degToRad(this.pitch);
    const dirX = Math.cos(pitch) * Math.cos(yaw);
    const dirY = Math.cos(pitch) * Math.sin(yaw);
    const dirZ = Math.sin(pitch);
    const px = player.x;
    const py = player.y;
    const pz = player.z + MOVE.capsuleHalfHeight;

    // Walk out along the arm until something is in the way (only trunks near the line matter)
    let reach = ARM_LENGTH;
    const step = 20;
    for (let d = step; d <= ARM_LENGTH; d += step) {
      if (!this.clear(player, px - dirX * d, py - dirY * d, pz - dirZ * d)) {
        reach = Math.max(d - step, 30);
        break;
      }
    }
    // Pull in at once, ease back out
    this.arm = reach < this.arm ? reach : Math.min(reach, this.arm + 600 * dt);

    const cx = px - dirX * this.arm;
    const cy = py - dirY * this.arm;
    const cz = pz - dirZ * this.arm;
    this.camera.position.set(cx * CM, cz * CM, cy * CM);
    this.camera.lookAt(px * CM, pz * CM, py * CM);
  }
}
