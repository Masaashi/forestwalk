// Controls for phones held sideways, and for a computer.
// Left side of the screen: a stick appears where the thumb touches (walk).
// Right side: drag to look around. Jump button at the bottom right.
// Keyboard: WASD or arrow keys to walk, Space to jump, E to climb, drag with the mouse to look.

const STICK_RADIUS = 56; // px the knob can move from the middle
const LOOK_SPEED = 0.25; // degrees per px dragged

export class Controls {
  constructor(surface, ui) {
    this.ui = ui;
    this.stick = null; // { id, x, y } where the thumb first touched
    this.stickX = 0;
    this.stickY = 0;
    this.lookId = null;
    this.lookLast = null;
    this.lookDX = 0;
    this.lookDY = 0;
    this.jumpQueued = false;
    this.climbQueued = false;
    this.keys = new Set();
    this.used = false; // the player has touched anything (hides the hint)

    surface.addEventListener('pointerdown', (e) => this.down(e));
    surface.addEventListener('pointermove', (e) => this.moveTo(e));
    surface.addEventListener('pointerup', (e) => this.up(e));
    surface.addEventListener('pointercancel', (e) => this.up(e));
    ui.jump.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.jumpQueued = true;
      this.used = true;
      ui.jump.classList.add('pressed');
    });
    ui.climb.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.climbQueued = true;
      this.used = true;
    });
    const release = () => ui.jump.classList.remove('pressed');
    ui.jump.addEventListener('pointerup', release);
    ui.jump.addEventListener('pointercancel', release);
    ui.jump.addEventListener('pointerleave', release);

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') this.jumpQueued = true;
      if (e.code === 'KeyE') this.climbQueued = true;
      this.used = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    // Stop the page from scrolling or zooming when fingers move on it
    document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  down(e) {
    e.preventDefault();
    this.used = true;
    try {
      e.target.setPointerCapture(e.pointerId); // keep getting this finger's moves even off the canvas
    } catch {
      // (fails for a pointer the browser no longer tracks; the moves still arrive on the canvas)
    }
    if (e.clientX < window.innerWidth * 0.45 && !this.stick) {
      this.stick = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.stickX = 0;
      this.stickY = 0;
      this.ui.stick.hidden = false;
      this.ui.stick.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      this.ui.knob.style.transform = 'translate(0px, 0px)';
    } else if (this.lookId === null) {
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  }

  moveTo(e) {
    if (this.stick && e.pointerId === this.stick.id) {
      let dx = e.clientX - this.stick.x;
      let dy = e.clientY - this.stick.y;
      const d = Math.hypot(dx, dy);
      if (d > STICK_RADIUS) {
        dx *= STICK_RADIUS / d;
        dy *= STICK_RADIUS / d;
      }
      this.stickX = dx / STICK_RADIUS;
      this.stickY = -dy / STICK_RADIUS; // up on the screen = forward
      this.ui.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    } else if (e.pointerId === this.lookId) {
      this.lookDX += e.clientX - this.lookLast.x;
      this.lookDY += e.clientY - this.lookLast.y;
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  }

  up(e) {
    if (this.stick && e.pointerId === this.stick.id) {
      this.stick = null;
      this.stickX = 0;
      this.stickY = 0;
      this.ui.stick.hidden = true;
    }
    if (e.pointerId === this.lookId) this.lookId = null;
  }

  /** Walk input: x = right, y = forward, each -1..1 (the stick, or the keys). */
  move() {
    let x = this.stickX;
    let y = this.stickY;
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    const d = Math.hypot(x, y);
    return d > 1 ? { x: x / d, y: y / d } : { x, y };
  }

  /** Look input since the last call, in degrees (yaw to the right, pitch up). */
  takeLook() {
    const look = { yaw: this.lookDX * LOOK_SPEED, pitch: -this.lookDY * LOOK_SPEED };
    this.lookDX = 0;
    this.lookDY = 0;
    return look;
  }

  takeClimb() {
    const climb = this.climbQueued;
    this.climbQueued = false;
    return climb;
  }

  takeJump() {
    const jump = this.jumpQueued;
    this.jumpQueued = false;
    return jump;
  }
}
