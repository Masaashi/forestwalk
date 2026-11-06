// Random numbers that come out exactly like the Unreal version's (a simple LCG),
// so the same seed puts the path, the stream and the trees in the same places.

const bits = new Uint32Array(1);
const asFloat = new Float32Array(bits.buffer);

export class RandomStream {
  constructor(seed) {
    this.seed = seed >>> 0;
  }

  mutate() {
    this.seed = (Math.imul(this.seed, 196314165) + 907633515) >>> 0;
  }

  /** A number in [0, 1), made from the top 23 bits of the seed (a 32-bit float). */
  fraction() {
    this.mutate();
    bits[0] = 0x3f800000 | (this.seed >>> 9);
    return asFloat[0] - 1.0;
  }

  /** A whole number from min to max, both included. */
  randRange(min, max) {
    const range = max - min + 1;
    return min + (range > 0 ? Math.trunc(Math.fround(this.fraction() * Math.fround(range))) : 0);
  }
}

/** A number between a and b. */
export function randBetween(rand, a, b) {
  return a + (b - a) * rand.fraction();
}

/** The seed for one part of the forest (int32 arithmetic, like the C++). */
export function partSeed(seed, part) {
  return (Math.imul(seed, 31) + part) | 0;
}
