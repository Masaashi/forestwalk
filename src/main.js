// Starts the web forest: makes the layout from the rules, builds the scene, and runs the
// game: walk with the stick, look by dragging, jump with the button.

import * as THREE from 'three';
import { FOREST_RULES } from './rules.js';
import { ForestLayout, distanceToLine } from './layout.js';
import { buildWorld, CM, wind } from './world.js';
import { ForestSky } from './sky.js';
import { PlayerMovement, buildFigure, MOVE } from './player.js';
import { FollowCamera } from './followCamera.js';
import { Controls } from './controls.js';
import { loadCharacter } from './character.js';

const params = new URLSearchParams(location.search);
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
// (?tone=aces / neutral / agx to compare)
renderer.toneMapping = { aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping, agx: THREE.AgXToneMapping }[params.get('tone')]
  ?? THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1500);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const player = new PlayerMovement(layout, world.trunkColliders);
// The stand-in figure shows until TakinT has loaded (?figure=simple keeps the stand-in)
let figure = buildFigure();
world.scene.add(figure.root);
let character = null;
if (params.get('figure') !== 'simple') {
  loadCharacter('models/TakinT.glb')
    .then((loaded) => {
      world.scene.remove(figure.root);
      figure = loaded;
      character = loaded;
      world.scene.add(figure.root);
      figure.update(player, 0);
    })
    .catch((error) => console.warn('TakinT could not be loaded; keeping the stand-in figure.', error));
}
const follow = new FollowCamera(camera, layout, world.trunkColliders);
follow.yaw = player.yaw;
const ui = {
  stick: document.getElementById('stick'),
  knob: document.getElementById('knob'),
  jump: document.getElementById('jump'),
  hint: document.getElementById('hint'),
};
const controls = new Controls(renderer.domElement, ui);

// Time of day: starts at 10:00 like the Unreal level (?time=18.5 to start at another hour)
const sky = new ForestSky(world.scene, renderer);
sky.setTime(Number(params.get('time')) || 10);
const timeButton = document.getElementById('time');
const TIMES = [6.5, 12, 18.4, 21.5]; // morning (with mist), noon, sunset, night
let timeGoal = null;
timeButton.textContent = sky.label;
timeButton.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  // Go on to the next time of day, letting the hours pass quickly on the way
  const next = TIMES.find((t) => t > sky.hour + 0.01) ?? TIMES[0] + 24;
  timeGoal = next;
});

function advanceTime(dt) {
  if (timeGoal === null) return;
  let hour = sky.hour;
  if (timeGoal - hour > 24) timeGoal -= 24;
  if (timeGoal < hour) hour -= 24; // passing midnight
  hour = Math.min(timeGoal, hour + dt * 4); // four hours a second
  sky.setTime(hour);
  if (hour >= timeGoal) timeGoal = null;
  timeButton.textContent = sky.label;
}

// The sun's shadow covers the area around the player
function placeSun() {
  const focus = new THREE.Vector3(player.x * CM, player.z * CM, player.y * CM);
  sky.follow(focus, camera);
}

const STEP = 1 / 60; // movement runs in fixed steps, so it acts the same at any frame rate
let pending = 0;

/** Turns stick input (relative to the camera) into a direction on the ground. */
function groundDirection(move) {
  const d = follow.directions();
  return { x: d.forwardX * move.y + d.rightX * move.x, y: d.forwardY * move.y + d.rightY * move.x };
}

function update(dt) {
  const look = controls.takeLook();
  follow.addLook(look.yaw, look.pitch);
  const dir = groundDirection(controls.move());
  let jump = controls.takeJump();
  pending = Math.min(pending + dt, 0.25);
  while (pending >= STEP) {
    player.step(STEP, dir.x, dir.y, jump);
    jump = false;
    pending -= STEP;
  }
  figure.update(player, dt);
  follow.update(player, dt);
  // When a trunk pushes the camera right up to the body, hide the body instead of looking inside it
  figure.root.visible = follow.arm > 70;
  advanceTime(dt);
  wind.time.value += dt;
  placeSun();
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
let frames = 0;
let windowStart = performance.now();
let last = performance.now();

let paused = false; // for pictures: the checks below can hold the game still

renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (!paused) update(dt);
  renderer.render(world.scene, camera);
  if (controls.used && !ui.hint.classList.contains('gone')) ui.hint.classList.add('gone');
  frames++;
  if (now - windowStart >= 1000) {
    stats.fps = Math.round((frames * 1000) / (now - windowStart));
    stats.frameMs = +((now - windowStart) / frames).toFixed(1);
    stats.calls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
    stats.ready = true;
    frames = 0;
    windowStart = now;
    if (!debugBox.hidden) {
      debugBox.textContent = `${stats.fps} fps  ${stats.calls} draws  ${(stats.triangles / 1000).toFixed(0)}k tris  dpr ${pixelRatio}`;
    }
  }
});

document.getElementById('loading').remove();
if (params.has('debug')) debugBox.hidden = false;
const fullscreen = document.getElementById('fullscreen');
if (document.fullscreenEnabled) {
  fullscreen.hidden = false;
  fullscreen.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().then(() => screen.orientation?.lock?.('landscape').catch(() => {}));
  });
}

// ---- Checks that run without a person (also when the page is in the background) ----

/**
 * Draws the scene a number of times and waits for the GPU each time, so the cost of one
 * frame can be measured even when the page is in the background (rAF is paused there).
 */
window.forestMeasure = (count = 60) => {
  const gl = renderer.getContext();
  const pixel = new Uint8Array(4);
  update(0);
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

/** Runs the movement for some seconds with a steering function, without drawing. */
function simulate(seconds, steer) {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    const { x, y, jump = false, done = false } = steer(i * STEP);
    if (done) return i * STEP;
    player.step(STEP, x, y, jump);
  }
  return seconds;
}

/**
 * Moves route points that lie on a bridge onto the middle of its deck. (Where the path bends
 * on a long bridge, the path line itself runs off the side of the deck, over the stream.)
 */
function keepOnBridges(points) {
  return points.map((p) => {
    for (const b of layout.bridges) {
      const ux = p.x - b.x;
      const uy = p.y - b.y;
      const u = ux * b.dirX + uy * b.dirY;
      const v = -ux * b.dirY + uy * b.dirX;
      if (Math.abs(u) <= b.length * 0.5 + 100 && Math.abs(v) <= b.width * 0.5 + 150) {
        return { x: b.x + b.dirX * u, y: b.y + b.dirY * u };
      }
    }
    return p;
  });
}

/** Follows a line of points on foot, like the Unreal walk test; counts how often it gets stuck. */
function walkAlong(routePoints, maxSeconds) {
  const points = keepOnBridges(routePoints);
  let index = 0;
  let stuck = 0;
  let checkAt = 0;
  let checkX = player.x;
  let checkY = player.y;
  const startDistance = player.distance;
  const time = simulate(maxSeconds, (t) => {
    while (index < points.length && Math.hypot(points[index].x - player.x, points[index].y - player.y) < 150) index++;
    if (index >= points.length) return { x: 0, y: 0, done: true };
    if (t - checkAt >= 2) {
      // Less than half a meter in 2 seconds: stuck. Skip ahead to the next point.
      if (Math.hypot(player.x - checkX, player.y - checkY) < 50) {
        stuck++;
        index = Math.min(index + 1, points.length - 1);
      }
      checkAt = t;
      checkX = player.x;
      checkY = player.y;
    }
    const dx = points[index].x - player.x;
    const dy = points[index].y - player.y;
    const d = Math.hypot(dx, dy);
    return { x: dx / d, y: dy / d };
  });
  return { walkedM: +((player.distance - startDistance) / 100).toFixed(1), seconds: +time.toFixed(1), stuck, reachedEnd: index >= points.length };
}

const inside = (p, margin = 300) => Math.abs(p.x) < layout.halfSize() - margin && Math.abs(p.y) < layout.halfSize() - margin;

window.forestTest = {
  player,
  follow,
  layout,
  /** Walk the main path from south to north, then each side path to its pond bench. */
  walkPaths() {
    const results = {};
    const main = layout.pathLine.filter((p) => inside(p));
    player.reset(main[0].x, main[0].y, 90);
    results.mainPath = walkAlong(main, 120);
    layout.sideLines.forEach((side, i) => {
      player.reset(side[0].x, side[0].y, 0);
      results[`pondPath${i + 1}`] = walkAlong(side, 60);
    });
    player.reset();
    return results;
  },
  /** Jump on the spot: how high and how long. */
  jump() {
    player.reset();
    const startZ = player.z;
    let top = startZ;
    let pressed = false;
    const time = simulate(3, () => {
      top = Math.max(top, player.z);
      if (pressed && player.grounded) return { x: 0, y: 0, done: true };
      const jump = !pressed;
      pressed = true;
      return { x: 0, y: 0, jump };
    });
    player.reset();
    return { heightCm: Math.round(top - startZ), airSeconds: +time.toFixed(2) };
  },
  /** Walk straight at a fallen log: does it stop at the log, and can it jump over? */
  log() {
    const log = layout.logs.reduce((a, b) => (b.radius > a.radius ? b : a));
    const yaw = THREE.MathUtils.degToRad(log.yaw);
    const across = { x: -Math.sin(yaw), y: Math.cos(yaw) };
    const tryIt = (jumpAt) => {
      player.reset(log.x - across.x * 300, log.y - across.y * 300, 0);
      let jumped = false;
      simulate(3, (t) => {
        const jump = jumpAt !== null && !jumped && t > jumpAt;
        if (jump) jumped = true;
        return { x: across.x, y: across.y, jump };
      });
      const side = (player.x - log.x) * across.x + (player.y - log.y) * across.y;
      return side > log.radius ? 'went over' : 'stopped';
    };
    const logTop = Math.round(log.radius * 1.7);
    const result = { logHeightCm: logTop, walking: tryIt(null), jumping: tryIt(0.3) };
    player.reset();
    return result;
  },
  /** Drop into the stream (away from bridges) at several places and walk out sideways. */
  streamEscape(count = 8) {
    const stream = layout.streamLine.filter((p) => inside(p, 600)
      && layout.bridges.every((b) => Math.hypot(p.x - b.x, p.y - b.y) > b.length));
    let out = 0;
    for (let i = 0; i < count; i++) {
      const k = Math.floor(((i + 0.5) / count) * (stream.length - 2));
      const a = stream[k];
      const b = stream[k + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const side = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
      const sign = i % 2 ? 1 : -1;
      player.reset(a.x, a.y, 0);
      // Out = standing on the ground clear of the stream banks at some point
      const bankEdge = layout.rules.StreamWidth * 0.5 + layout.rules.StreamBankWidth + 100;
      let climbed = false;
      simulate(4, () => {
        if (player.grounded && distanceToLine(layout.streamLine, player.x, player.y) > bankEdge) climbed = true;
        return { x: side.x * sign, y: side.y * sign, done: climbed };
      });
      if (climbed) out++;
    }
    player.reset();
    return { tries: count, climbedOut: out };
  },
  /** Walk in straight lines across the forest; count times it could not move at all for 2 s. */
  wander(seconds = 120, seed = 7) {
    let s = seed;
    const random = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    player.reset();
    let dir = { x: 0, y: 1 };
    let trapped = 0; // inside the forest
    let atEdge = 0; // pushing against the invisible wall at the walkable edge
    let lastX = player.x;
    let lastY = player.y;
    let checkAt = 0;
    let turnAt = 0;
    const startDistance = player.distance;
    simulate(seconds, (t) => {
      if (t >= turnAt) {
        const a = random() * Math.PI * 2;
        dir = { x: Math.cos(a), y: Math.sin(a) };
        turnAt = t + 3 + random() * 4;
      }
      if (t - checkAt >= 2) {
        if (Math.hypot(player.x - lastX, player.y - lastY) < 20) {
          const edgeGap = layout.halfSize() - Math.max(Math.abs(player.x), Math.abs(player.y));
          if (edgeGap < MOVE.capsuleRadius + 20) atEdge++;
          else trapped++;
          turnAt = t; // pick a new direction
        }
        checkAt = t;
        lastX = player.x;
        lastY = player.y;
      }
      return { x: dir.x, y: dir.y, jump: random() < 0.004 };
    });
    const result = { walkedM: Math.round((player.distance - startDistance) / 100), trapped, atEdge };
    player.reset();
    return result;
  },
  /** Put the player somewhere and draw one frame (for pictures). */
  place(x, y, yaw, cameraYaw = yaw, cameraPitch = -15, arm = 400) {
    player.reset(x, y, yaw);
    follow.yaw = cameraYaw;
    follow.pitch = cameraPitch;
    follow.arm = arm;
    update(0);
    renderer.render(world.scene, camera);
  },
  /** Walk forward with the stick held for some seconds (to see the walk in a picture). */
  walkFor(seconds, x = 0, y = 1) {
    // (the figure's walk cycle advances with the movement, step by step)
    simulate(seconds, () => {
      figure.update(player, STEP);
      return groundDirection({ x, y });
    });
    update(0);
    renderer.render(world.scene, camera);
    return { x: Math.round(player.x), y: Math.round(player.y), speed: Math.round(player.speed), grounded: player.grounded };
  },
  /** Point the camera at the player from a direction without moving the player (for pictures). */
  shoot(cameraYaw, cameraPitch = -5, arm = 300) {
    follow.yaw = cameraYaw;
    follow.pitch = cameraPitch;
    follow.arm = arm;
    follow.update(player, 0);
    figure.root.visible = true;
    placeSun();
    renderer.render(world.scene, camera);
  },
  /** Hold the game still (true) so a picture stays as placed, or let it run again (false). */
  pause(on = true) {
    paused = on;
  },
  /** Set the time of day at once (hours, e.g. 18.4). */
  setTime(hour) {
    sky.setTime(hour);
    timeButton.textContent = sky.label;
    update(0);
    renderer.render(world.scene, camera);
    return sky.label;
  },
  sky,
  get character() {
    return character;
  },
  renderer,
  scene: world.scene,
  move: MOVE,
};
