// Time of day: the sun's path, sky colors, fog, morning mist and moonlight at night.
// The sun's path and the light amounts follow the Unreal version (AForestSky); the sky
// colors, which Unreal's Sky Atmosphere works out on its own, are painted here by hand.

import * as THREE from 'three';
const SUNRISE = 5.5;
const SUNSET = 19;
const MAX_ELEVATION = 58;
const FOG_DENSITY = 0.011;
const MORNING_MIST = 1.5;

const smoothStep = (a, b, x) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const rgb = (r, g, b) => new THREE.Color().setRGB(r, g, b);
const mix = (a, b, t) => a.clone().lerp(b, t);

/** 0 at sunrise, 1 at sunset, above 1 during the night. */
function dayFraction(hour) {
  const length = SUNSET - SUNRISE;
  if (hour >= SUNRISE && hour <= SUNSET) return (hour - SUNRISE) / length;
  return 1 + (((hour - SUNSET + 24) % 24) / length);
}

/** Sun angle above the horizon in degrees (below zero at night). */
export function sunElevation(hour) {
  const f = dayFraction(hour);
  if (f >= 0 && f <= 1) return MAX_ELEVATION * Math.sin(Math.PI * f);
  const nightLength = 24 - (SUNSET - SUNRISE);
  const afterSunset = (f - 1) * (SUNSET - SUNRISE);
  return -30 * Math.sin(Math.PI * THREE.MathUtils.clamp(afterSunset / nightLength, 0, 1));
}

/** Compass direction toward the sun (Unreal yaw: rises toward +X, south at noon, sets toward -X). */
export function sunYaw(hour) {
  return -180 * dayFraction(hour);
}

// Sky colors for day, low sun and night
const SKY = {
  dayZenith: rgb(0.12, 0.30, 0.70),
  dayHorizon: rgb(0.55, 0.68, 0.85),
  lowZenith: rgb(0.14, 0.22, 0.50),
  lowHorizon: rgb(0.62, 0.26, 0.10), // (bright colors turn pale in the tone mapping, so these are deep)
  nightZenith: rgb(0.004, 0.008, 0.025),
  nightHorizon: rgb(0.025, 0.04, 0.075),
  mist: rgb(0.78, 0.78, 0.74),
};

export class ForestSky {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.hour = 10;

    // Sky dome: a color from the horizon up to the top, a glow around the sun, stars at night
    this.skyUniforms = {
      zenith: { value: SKY.dayZenith.clone() },
      horizon: { value: SKY.dayHorizon.clone() },
      sunColor: { value: rgb(1, 0.9, 0.7) },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunGlow: { value: 1 },
      sunsetColor: { value: rgb(0.75, 0.22, 0.04) },
      sunsetAmount: { value: 0 },
    };
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: this.skyUniforms,
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position = p.xyww;
          }`,
        fragmentShader: `
          uniform vec3 zenith;
          uniform vec3 horizon;
          uniform vec3 sunColor;
          uniform vec3 sunDir;
          uniform float sunGlow;
          uniform vec3 sunsetColor;
          uniform float sunsetAmount;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float up = clamp(d.y, 0.0, 1.0);
            vec3 color = mix(horizon, zenith, pow(up, 0.55));
            float toSun = max(dot(d, sunDir), 0.0);
            // Sunrise and sunset: an orange band low in the sky on the sun's side
            float sunSide = 0.5 + 0.5 * dot(normalize(d.xz + 1e-5), normalize(sunDir.xz + 1e-5));
            color = mix(color, sunsetColor, sunsetAmount * sunSide * sunSide * pow(1.0 - up, 2.0));
            // A wide warm glow around the sun (strongest near the horizon), and the sun itself
            color += sunColor * (pow(toSun, 6.0) * 0.18 + pow(toSun, 40.0) * 0.5) * sunGlow * (1.0 - up * 0.6);
            color += sunColor * smoothstep(0.9993, 0.9997, toSun) * 6.0 * step(-0.03, sunDir.y);
            if (d.y < 0.0) color = horizon * 0.85;
            gl_FragColor = vec4(color, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    dome.name = 'Sky';
    dome.frustumCulled = false;
    dome.renderOrder = -2;
    scene.add(dome);
    this.dome = dome;

    // Stars: dots on the dome, only seen at night
    const starPositions = [];
    let seed = 12345;
    const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    while (starPositions.length < 900 * 3) {
      const v = new THREE.Vector3(random() * 2 - 1, random(), random() * 2 - 1);
      if (v.lengthSq() > 1 || v.y < 0.08) continue;
      v.normalize().multiplyScalar(950);
      starPositions.push(v.x, v.y, v.z);
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
    this.starMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
    this.stars = new THREE.Points(starGeometry, this.starMaterial);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -1;
    scene.add(this.stars);

    // The moon: a pale disc in the sky at night
    this.moonDisc = new THREE.Mesh(
      new THREE.CircleGeometry(16, 24),
      new THREE.MeshBasicMaterial({ color: rgb(0.85, 0.9, 1.0), fog: false, transparent: true, depthWrite: false }),
    );
    this.moonDisc.renderOrder = -1;
    scene.add(this.moonDisc);

    // Lights: the sun (with shadows), a dim bluish moon, and light from the whole sky
    this.sun = new THREE.DirectionalLight(0xffffff, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const reach = 35;
    Object.assign(this.sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: 160 });
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    scene.add(this.sun, this.sun.target);
    this.moon = new THREE.DirectionalLight(rgb(0.55, 0.65, 1.0), 0);
    scene.add(this.moon, this.moon.target);
    this.skyLight = new THREE.HemisphereLight(SKY.dayHorizon, rgb(0.12, 0.14, 0.06), 1.3);
    scene.add(this.skyLight);

    scene.fog = new THREE.FogExp2(SKY.dayHorizon.clone(), FOG_DENSITY);
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.moonDirection = new THREE.Vector3(0, 1, 0);
    this.setTime(this.hour);
  }

  /** Unreal direction (yaw, elevation in degrees) to a Three.js unit vector. */
  static direction(yawDeg, elevationDeg) {
    const yaw = THREE.MathUtils.degToRad(yawDeg);
    const e = THREE.MathUtils.degToRad(elevationDeg);
    return new THREE.Vector3(Math.cos(e) * Math.cos(yaw), Math.sin(e), Math.cos(e) * Math.sin(yaw));
  }

  setTime(hour) {
    this.hour = ((hour % 24) + 24) % 24;
    const elevation = sunElevation(this.hour);
    const yaw = sunYaw(this.hour);
    this.elevation = elevation;
    this.sunDirection.copy(ForestSky.direction(yaw, elevation));
    // Moon high in the sky on the other side from where the sun went down
    this.moonDirection.copy(ForestSky.direction(yaw + 180, 40));

    const day = smoothStep(-4, 4, elevation); // the sun is up
    const night = 1 - smoothStep(-6, 2, elevation); // the moon is out
    const low = 1 - smoothStep(3, 20, elevation); // the sun is low: warm light, colored sky

    // Sun light: warm white, orange when low, gone below the horizon
    const sunColor = mix(rgb(1.0, 0.95, 0.85), rgb(1.0, 0.5, 0.22), low);
    this.sun.color.copy(sunColor);
    // (both lights stay switched on, only dimmed: switching one off would make every
    // material rebuild its shader, a visible stutter on phones)
    this.sun.intensity = 3.2 * day;
    this.moon.intensity = 0.55 * night;

    // Sky colors
    const dayZenith = mix(SKY.dayZenith, SKY.lowZenith, low);
    const dayHorizon = mix(SKY.dayHorizon, SKY.lowHorizon, low * day);
    const zenith = mix(dayZenith, SKY.nightZenith, night);
    let horizon = mix(dayHorizon, SKY.nightHorizon, night);
    // Morning mist: thicker, paler fog about an hour after sunrise
    const mist = Math.exp(-(((this.hour - (SUNRISE + 1)) / 1.2) ** 2));
    horizon = mix(horizon, SKY.mist.clone().multiplyScalar(0.4 + 0.6 * day), mist * 0.55 * day);
    this.skyUniforms.zenith.value.copy(zenith);
    this.skyUniforms.horizon.value.copy(horizon);
    this.skyUniforms.sunColor.value.copy(sunColor);
    this.skyUniforms.sunDir.value.copy(this.sunDirection);
    this.skyUniforms.sunGlow.value = day * (0.6 + 1.4 * low);
    this.skyUniforms.sunsetAmount.value = low * smoothStep(-6, 2, elevation) * 0.9;
    this.scene.fog.color.copy(horizon);
    this.scene.fog.density = FOG_DENSITY * (1 + MORNING_MIST * mist);

    // Light from the whole sky: blue by day, warm at dusk, a little blue light at night
    const skyTint = mix(rgb(0.55, 0.7, 1.0), rgb(0.75, 0.6, 0.6), low * day);
    this.skyLight.color.copy(mix(skyTint, rgb(0.35, 0.45, 0.8), night));
    this.skyLight.intensity = THREE.MathUtils.lerp(1.3, 0.28, night) * (1 - 0.25 * low * day);

    this.starMaterial.opacity = night;
    this.moonDisc.material.opacity = night;
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(1.0, 1.25, night);
  }

  /** Keeps the shadow area around the player and the sky dome around the camera. */
  follow(focus, camera) {
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDirection, 80);
    this.moon.target.position.copy(focus);
    this.moon.position.copy(focus).addScaledVector(this.moonDirection, 80);
    this.dome.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    this.moonDisc.position.copy(camera.position).addScaledVector(this.moonDirection, 900);
    this.moonDisc.lookAt(camera.position);
  }

  /** Name of the time of day, for the button. */
  get label() {
    const h = this.hour;
    const name = h >= 4.5 && h < 9 ? '朝' : h >= 9 && h < 16 ? '昼' : h >= 16 && h < 19.5 ? '夕方' : '夜';
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    return `${name} ${hh}:${String(mm).padStart(2, '0')}`;
  }
}

