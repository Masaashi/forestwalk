// Starts the web forest: makes the layout from the rules, builds the scene and draws it.
// Step 1 (prototype): look around from a few fixed spots by dragging. Walking comes next.

import * as THREE from 'three';
import { FOREST_RULES } from './rules.js';
import { ForestLayout } from './layout.js';
import { buildWorld, CM } from './world.js';

const params = new URLSearchParams(location.search);
const loading = document.getElementById('loading');
const debugBox = document.getElementById('debug');

const startedAt = performance.now();
const layout = new ForestLayout(FOREST_RULES);
const layoutMs = performance.now() - startedAt;
const world = buildWorld(layout);
const buildMs = performance.now() - startedAt - layoutMs;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
const pixelRatio = Number(params.get('dpr')) || Math.min(window.devicePixelRatio, 2);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1500);

/** Unreal position (cm, Z up) to Three.js (m, Y up). */
const toThree = (x, y, z) => new THREE.Vector3(x * CM, z * CM, y * CM);
const eyeHeight = 170;

// A few fixed spots to look from (?view=path|forest|pond|overview)
function viewpoint(name) {
  const start = layout.pathStart;
  const ahead = layout.pathLine.find((p) => p.y > start.y + 1000) ?? { x: start.x, y: start.y + 1000 };
  switch (name) {
    case 'overview':
      return { from: new THREE.Vector3(-70, 45, -70), to: new THREE.Vector3(0, 0, 0) };
    case 'forest': {
      const from = toThree(1800, -2200, layout.groundZ(1800, -2200) + eyeHeight);
      return { from, to: toThree(3200, 1500, layout.groundZ(3200, 1500) + eyeHeight + 100) };
    }
    case 'pond': {
      const bench = layout.benches[0];
      const pond = layout.ponds[0];
      if (bench && pond) {
        const dx = bench.x - pond.x;
        const dy = bench.y - pond.y;
        const len = Math.hypot(dx, dy);
        const bx = bench.x + (dx / len) * 300;
        const by = bench.y + (dy / len) * 300;
        return {
          from: toThree(bx, by, layout.groundZ(bx, by) + eyeHeight),
          to: toThree(pond.x, pond.y, pond.waterZ + 60),
        };
      }
      return viewpoint('path');
    }
    default:
      return {
        from: toThree(start.x, start.y, layout.groundZ(start.x, start.y) + eyeHeight),
        to: toThree(ahead.x, ahead.y, layout.groundZ(ahead.x, ahead.y) + eyeHeight - 30),
      };
  }
}

const view = viewpoint(params.get('view') ?? 'path');
camera.position.copy(view.from);
const look = new THREE.Vector3().subVectors(view.to, view.from).normalize();
let yaw = Math.atan2(look.x, look.z);
let pitch = Math.asin(THREE.MathUtils.clamp(look.y, -1, 1));

function applyLook() {
  const cp = Math.cos(pitch);
  camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp)));
}
applyLook();

// Drag (finger or mouse) to look around
let dragging = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  dragging = { x: e.clientX, y: e.clientY };
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const speed = 0.005;
  yaw -= (e.clientX - dragging.x) * speed;
  pitch = THREE.MathUtils.clamp(pitch - (e.clientY - dragging.y) * speed, -1.2, 1.2);
  dragging = { x: e.clientX, y: e.clientY };
  applyLook();
});
renderer.domElement.addEventListener('pointerup', () => { dragging = null; });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// The sun's shadow covers the area in front of the camera
const shadowFocus = new THREE.Vector3();
function placeSun() {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();
  shadowFocus.copy(camera.position).addScaledVector(forward, 15);
  shadowFocus.y = layout.groundZ(shadowFocus.x / CM, shadowFocus.z / CM) * CM;
  world.sun.target.position.copy(shadowFocus);
  world.sun.position.copy(shadowFocus).addScaledVector(world.sunDirection, 80);
}

// Frame rate, for the debug box and for automatic checks (window.forestStats)
const stats = {
  ready: false,
  fps: 0,
  frameMs: 0,
  calls: 0,
  triangles: 0,
  layoutMs: Math.round(layoutMs),
  buildMs: Math.round(buildMs),
  trees: layout.trees.length,
  grass: layout.grass.length,
  pixelRatio,
};
window.forestStats = stats;
window.forestDebug = { scene: world.scene, camera, renderer, layout };

/**
 * Draws the scene a number of times and waits for the GPU each time, so the cost of one
 * frame can be measured even when the page is in the background (rAF is paused there).
 */
window.forestMeasure = (count = 60) => {
  const gl = renderer.getContext();
  const pixel = new Uint8Array(4);
  placeSun();
  renderer.render(world.scene, camera);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  const t0 = performance.now();
  for (let i = 0; i < count; i++) {
    renderer.render(world.scene, camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); // wait for the GPU to finish
  }
  const ms = (performance.now() - t0) / count;
  return { msPerFrame: +ms.toFixed(2), fpsIfAlone: Math.round(1000 / ms), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
};
let frames = 0;
let windowStart = performance.now();

renderer.setAnimationLoop((now) => {
  placeSun();
  renderer.render(world.scene, camera);
  frames++;
  if (now - windowStart >= 1000) {
    stats.fps = Math.round((frames * 1000) / (now - windowStart));
    stats.frameMs = +((now - windowStart) / frames).toFixed(1);
    stats.calls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
    stats.ready = true;
    frames = 0;
    windowStart = now;
    if (debugBox) {
      debugBox.textContent = `${stats.fps} fps  ${stats.calls} draws  ${(stats.triangles / 1000).toFixed(0)}k tris  dpr ${pixelRatio}`;
    }
  }
});

loading.remove();
if (params.has('debug')) debugBox.hidden = false;
