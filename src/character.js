// TakinT on the web: loads the .glb (made by Scripts/ExportWebModel.py) and moves its bones in
// code, since the Unreal mannequin's animations cannot be used outside Unreal.
//
// Each frame the skeleton starts from its T pose, then bones are turned so they point where
// the pose wants them (like the climbing pose in ForestClimbAnimInstance.cpp): "this upper arm
// points down and a little forward". That works whatever way each bone's own axes face.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CM } from './world.js';

const BONES = [
  'root', 'pelvis', 'spine_01', 'spine_05', 'neck_01', 'head',
  'upperarm_l', 'lowerarm_l', 'hand_l', 'upperarm_r', 'lowerarm_r', 'hand_r',
  'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r',
];

const smooth = (current, target, rate, dt) => current + (target - current) * (1 - Math.exp(-rate * dt));

export async function loadCharacter(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const model = gltf.scene;
  const bones = {};
  let skinned = null;
  model.traverse((o) => {
    if (o.isBone && BONES.includes(o.name)) bones[o.name] = o;
    if (o.isSkinnedMesh) skinned = o;
  });
  const missing = BONES.filter((n) => !bones[n]);
  if (!skinned || missing.length) throw new Error(`Character model is missing: ${missing.join(', ') || 'a skinned mesh'}`);

  // Same simple lighting as the rest of the forest; keep only the color texture
  skinned.material = new THREE.MeshLambertMaterial({ map: skinned.material.map, side: THREE.DoubleSide });
  skinned.castShadow = true;
  skinned.receiveShadow = true;
  skinned.frustumCulled = false; // the bones move it away from its T-pose bounds

  // Which way the model faces: from the heel toward the toes. Turn it to face +X like the
  // stand-in figure (the player code turns +X to where the player looks).
  model.updateMatrixWorld(true);
  const p = (name) => bones[name].getWorldPosition(new THREE.Vector3());
  const toes = p('ball_l').sub(p('foot_l')).setY(0).normalize();
  const holder = new THREE.Group();
  holder.add(model);
  model.rotation.y = Math.atan2(toes.z, toes.x); // turns the toes' direction onto +X
  holder.updateMatrixWorld(true);

  const rest = {};
  for (const name of BONES) rest[name] = bones[name].quaternion.clone();

  const root = new THREE.Group();
  root.add(holder);

  // Reused vectors
  const q = new THREE.Quaternion();
  const parentQ = new THREE.Quaternion();
  const boneQ = new THREE.Quaternion();
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const F = new THREE.Vector3();
  const U = new THREE.Vector3();
  const R = new THREE.Vector3();
  const dir = new THREE.Vector3();

  /** Turns a bone so the line from it to its child points along a direction (forward, up, right). */
  function aim(boneName, childName, f, u, r) {
    const bone = bones[boneName];
    bone.getWorldPosition(from);
    bones[childName].getWorldPosition(to);
    to.sub(from).normalize();
    dir.set(0, 0, 0).addScaledVector(F, f).addScaledVector(U, u).addScaledVector(R, r).normalize();
    q.setFromUnitVectors(to, dir);
    bone.parent.getWorldQuaternion(parentQ);
    bone.getWorldQuaternion(boneQ);
    bone.quaternion.copy(parentQ.invert().multiply(q).multiply(boneQ));
    bone.updateMatrixWorld(true);
  }

  // Animation state
  let phase = 0;
  let walk = 0; // 0 standing .. 1 walking
  let run = 0; // 0 walking .. 1 running
  let air = 0; // 0 on the ground .. 1 in the air

  function update(player, dt) {
    root.position.set(player.x * CM, player.z * CM, player.y * CM);
    root.rotation.y = -THREE.MathUtils.degToRad(player.yaw);
    const speed = player.speed;
    walk = smooth(walk, Math.min(speed / 120, 1), 10, dt);
    run = smooth(run, THREE.MathUtils.clamp((speed - 260) / 220, 0, 1), 6, dt);
    air = smooth(air, player.grounded ? 0 : 1, 12, dt);
    // One cycle = two steps; steps are longer when running
    const stepLength = 70 + 45 * run;
    if (player.grounded) phase += (speed * dt * Math.PI) / stepLength;

    // The body's directions in the world
    root.updateMatrixWorld(true);
    root.getWorldQuaternion(q);
    F.set(1, 0, 0).applyQuaternion(q);
    U.set(0, 1, 0);
    R.set(0, 0, 1).applyQuaternion(q);

    // Start from the T pose
    for (const name of BONES) bones[name].quaternion.copy(rest[name]);
    holder.position.y = 0;
    holder.updateMatrixWorld(true);

    if (player.climbing) {
      climbPose(player.climbCycle);
      return;
    }

    const ground = 1 - air;
    const s = walk * ground;
    // A little bounce while walking, more when running
    holder.position.y = -Math.abs(Math.cos(phase)) * 0.025 * s * (1 + run) + 0.012 * s;

    // Upper body: upright, leaning in a little when running; head looking ahead
    const lean = 0.04 + 0.13 * run * s;
    aim('spine_01', 'spine_05', Math.sin(lean), Math.cos(lean), 0);
    aim('neck_01', 'head', 0.1 - 0.08 * run * s, 1, 0);

    for (const side of [-1, 1]) {
      const l = side < 0 ? 'l' : 'r';
      // Legs: swing forward and back in turn; the knee bends while the leg comes forward
      const legPhase = phase + (side < 0 ? 0 : Math.PI);
      const swing = Math.sin(legPhase) * (0.32 + 0.22 * run) * s;
      const bend = (0.05 + Math.max(0, Math.cos(legPhase)) * (0.25 + 0.75 * run)) * s;
      // In the air: the left knee comes up, the right leg trails
      const airSwing = side < 0 ? 0.65 : -0.15;
      const airBend = side < 0 ? 1.1 : 0.35;
      const thigh = swing * ground + airSwing * air;
      const knee = bend + airBend * air;
      aim(`thigh_${l}`, `calf_${l}`, Math.sin(thigh), -Math.cos(thigh), 0.04 * side);
      aim(`calf_${l}`, `foot_${l}`, Math.sin(thigh - knee), -Math.cos(thigh - knee), 0.02 * side);
      aim(`foot_${l}`, `ball_${l}`, 1, -0.25 - 0.4 * air, 0);

      // Arms: down at the sides, swinging against the legs, elbows bent more when running
      const armPhase = phase + (side < 0 ? Math.PI : 0);
      const armSwing = Math.sin(armPhase) * (0.22 + 0.35 * run) * s;
      const elbow = 0.18 + 0.75 * run * s + Math.max(0, armSwing) * 0.6;
      const upperF = Math.sin(armSwing) * ground + 0.25 * air;
      const upperU = -Math.cos(armSwing) * ground - 0.3 * air;
      const upperR = 0.2 * ground + 0.75 * air;
      aim(`upperarm_${l}`, `lowerarm_${l}`, upperF, upperU, upperR * side);
      const lowerA = armSwing * ground + elbow * ground + 0.6 * air;
      aim(`lowerarm_${l}`, `hand_${l}`, Math.sin(lowerA), -Math.cos(lowerA) * ground + 0.2 * air, (0.08 * ground + 0.6 * air) * side);
    }
  }

  const mixDir = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  /**
   * Holding on to a trunk (the same pose as ForestClimbAnimInstance.cpp): leaning in, hands
   * reaching up in turn, the opposite knee coming up. Directions are (forward, up, right),
   * forward being toward the trunk.
   */
  function climbPose(cycle) {
    walk = 0;
    air = 0;
    const swing = 0.5 + 0.5 * Math.sin(cycle * 2 * Math.PI); // 1 = left hand high, right foot high
    aim('spine_01', 'spine_05', ...mixDir([0, 1, 0], [1, 0, 0], 0.18));
    aim('neck_01', 'head', 0.25, 1, 0); // looking up the trunk a little
    for (const side of [-1, 1]) {
      const l = side < 0 ? 'l' : 'r';
      const high = side < 0 ? swing : 1 - swing;
      aim(`upperarm_${l}`, `lowerarm_${l}`, ...mixDir([0.55, 0.15, 0.45 * side], [0.35, 0.95, 0.25 * side], high));
      aim(`lowerarm_${l}`, `hand_${l}`, ...mixDir([0.9, 0.35, -0.25 * side], [0.45, 0.9, -0.15 * side], high));
      const lift = side < 0 ? 1 - swing : swing;
      aim(`thigh_${l}`, `calf_${l}`, ...mixDir([0.25, -0.95, 0.15 * side], [0.9, -0.25, 0.2 * side], lift));
      aim(`calf_${l}`, `foot_${l}`, ...mixDir([0.1, -1, 0], [-0.25, -1, 0], lift));
      aim(`foot_${l}`, `ball_${l}`, 1, -0.2, 0);
    }
  }

  return { root, update, bones };
}
