// Picture quality, so older phones can play too: high / medium / low, or automatic (starts
// high and steps down while the frame rate stays low). The choice is remembered on the phone.

export const QUALITY = {
  high: { label: '高', pixelRatio: 2, shadows: true, shadowSize: 2048, grass: 1, ferns: 1 },
  medium: { label: '中', pixelRatio: 1.5, shadows: true, shadowSize: 1024, grass: 0.6, ferns: 0.7 },
  low: { label: '低', pixelRatio: 1, shadows: false, shadowSize: 1024, grass: 0.35, ferns: 0.5 },
};
const LEVELS = ['high', 'medium', 'low'];
const CHOICES = ['auto', 'high', 'medium', 'low'];
const STORAGE_KEY = 'forest-quality';

const AUTO_MIN_FPS = 45; // below this, automatic quality steps down
const AUTO_WARMUP = 1.5; // seconds to wait after a change before measuring
const AUTO_SAMPLE = 3; // seconds of frames to average

/** The quality choice saved on this phone ('auto' if none). Storage may be blocked. */
export function savedChoice() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return CHOICES.includes(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export class Quality {
  constructor({ renderer, scene, sun, world, button, toast }) {
    this.renderer = renderer;
    this.scene = scene;
    this.sun = sun;
    this.world = world;
    this.button = button;
    this.toast = toast;
    this.choice = savedChoice();
    this.level = this.choice === 'auto' ? 'high' : this.choice;
    this.applied = null;
    this.resetAuto();
    this.apply(this.level);
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.cycle();
    });
  }

  resetAuto() {
    this.settled = this.choice !== 'auto';
    this.waited = 0;
    this.sampled = 0;
    this.frames = 0;
  }

  /** Puts a quality level into effect. */
  apply(level) {
    const q = QUALITY[level];
    const before = this.applied ? QUALITY[this.applied] : null;
    this.level = level;
    this.applied = level;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    if (!before || before.shadows !== q.shadows || before.shadowSize !== q.shadowSize) {
      this.renderer.shadowMap.enabled = q.shadows;
      this.sun.castShadow = q.shadows;
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
      this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      // Turning shadows on or off changes every material's shader
      if (before) this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    }
    this.world.setDetail(q.grass, q.ferns);
    this.button.textContent = `画質 ${this.choice === 'auto' ? '自動・' : ''}${q.label}`;
  }

  /** Next choice: auto -> high -> medium -> low -> auto. */
  cycle() {
    this.choice = CHOICES[(CHOICES.indexOf(this.choice) + 1) % CHOICES.length];
    try {
      localStorage.setItem(STORAGE_KEY, this.choice);
    } catch {
      // (not saved; still used until the page is closed)
    }
    this.resetAuto();
    this.apply(this.choice === 'auto' ? 'high' : this.choice);
    if (this.choice === 'low') this.say('画質「低」: 次に開いたときはギザギザを消す処理も止めて、さらに軽くなります');
  }

  say(text) {
    this.toast.textContent = text;
    this.toast.classList.add('shown');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove('shown'), 3500);
  }

  /** Called every frame with the frame time; automatic quality steps down while it is slow. */
  tick(dt) {
    if (this.settled) return;
    if (this.waited < AUTO_WARMUP) {
      this.waited += dt;
      return;
    }
    this.sampled += dt;
    this.frames++;
    if (this.sampled < AUTO_SAMPLE) return;
    const fps = this.frames / this.sampled;
    const next = LEVELS[LEVELS.indexOf(this.level) + 1];
    if (fps < AUTO_MIN_FPS && next) {
      this.apply(next);
      this.say(`動きが重いので、画質を「${QUALITY[next].label}」にしました（${Math.round(fps)} fps）`);
      this.waited = 0;
      this.sampled = 0;
      this.frames = 0;
    } else {
      this.settled = true;
      this.lastFps = Math.round(fps);
    }
  }
}
