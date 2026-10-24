/*
 * Deep Brown: the whole sound engine, running on the audio rendering thread.
 *
 *   white noise -> leaky integrator (= brown noise) -> highpass 18 Hz -> lowpass -> lowpass
 *   -> low shelf -> makeup gain -> soft limiter -> volume
 *
 * Everything is computed in 64-bit floats inside this one processor. The earlier
 * version used a chain of native nodes (biquads, compressor, LFO oscillators);
 * a single processor has no node-to-node buffering, no compressor pumping and
 * no per-node smoothing quirks, and every parameter is smoothed per sample here.
 * Nothing is allocated inside process(): no garbage collection, no glitches.
 */
const TWO_PI = 2 * Math.PI;
const LN2 = Math.LN2;
const Q_BUTTER = Math.SQRT1_2;                 // 0.7071: maximally flat
const Q_PEAK = Math.pow(10, 1.5 / 20);         // 1.19: slight warmth at the corner
const SHELF_HZ = 90;
const HP_HZ = 18;

class BrownNoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = (name, def, min, max) => ({ name, defaultValue: def, minValue: min, maxValue: max, automationRate: 'k-rate' });
    return [
      k('width', 0.6, 0, 1),        // 0 mono ... 1 independent L/R
      k('cutoff', 200, 10, 4000),   // Hz, lowpass corner ("deepness")
      k('shelfDb', 0, 0, 18),       // low-shelf boost at 90 Hz ("rumble")
      k('makeup', 1, 0, 20),        // level compensation, computed on the main thread
      k('swell', 0, 0, 1200),       // slow cutoff modulation depth in cents
      k('volume', 0, 0, 1),         // linear output gain
    ];
  }

  constructor() {
    super();
    const sr = sampleRate;
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.a = ((seed ^ 0x9e3779b9) >>> 0) || 0x1234567;
    this.b = ((Math.imul(seed, 1664525) + 1013904223) ^ 0x85ebca6b) >>> 0 || 0x7654321;
    this.yL = 0; this.yR = 0;

    // leaky integrator: stops integrating below 10 Hz so it can never drift away
    this.p = Math.exp((-2 * Math.PI * 10) / sr);
    this.g = (0.5 * Math.sqrt(1 - this.p * this.p)) / Math.sqrt(1 / 3);

    // filters: 4 stages x [b0 b1 b2 a1 a2]; state: 2 channels x 4 stages x [z1 z2]
    this.c = new Float64Array(20);
    this.z = new Float64Array(16);
    this.setHighpass();
    this.shelfCos = Math.cos((TWO_PI * SHELF_HZ) / sr);
    this.shelfSin = Math.sin((TWO_PI * SHELF_HZ) / sr);

    // smoothed parameter values (initialised from the first block, so nothing ramps in from defaults)
    this.ready = false;
    this.sCut = 0; this.sShelf = 0; this.sMake = 1; this.sVol = 0; this.sSwell = 0; this.sWidth = 0.6;
    this.ks = 1 - Math.exp(-1 / (sr * 0.05));   // 50 ms smoothing
    this.phA = 0; this.phB = 1.7;
    this.dA = (TWO_PI * 0.043) / sr; this.dB = (TWO_PI * 0.117) / sr;
    this.n = 0; this.sCor = 0.8; this.sInd = 0.6;
  }

  setHighpass() {
    const w0 = (TWO_PI * HP_HZ) / sampleRate, cs = Math.cos(w0), al = Math.sin(w0) / (2 * Q_BUTTER);
    const a0 = 1 + al, c = this.c;
    c[0] = ((1 + cs) / 2) / a0; c[1] = -(1 + cs) / a0; c[2] = c[0]; c[3] = (-2 * cs) / a0; c[4] = (1 - al) / a0;
  }

  // recompute lowpass x2 and shelf (called every 8 samples; parameters move slowly, so this is plenty)
  setCoeffs(lnCut, shelfDb) {
    const c = this.c;
    const f = Math.min(Math.exp(lnCut), sampleRate * 0.45);
    const w0 = (TWO_PI * f) / sampleRate, cs = Math.cos(w0), sn = Math.sin(w0);
    let al = sn / (2 * Q_BUTTER), a0 = 1 + al;
    c[5] = ((1 - cs) / 2) / a0; c[6] = (1 - cs) / a0; c[7] = c[5]; c[8] = (-2 * cs) / a0; c[9] = (1 - al) / a0;
    al = sn / (2 * Q_PEAK); a0 = 1 + al;
    c[10] = ((1 - cs) / 2) / a0; c[11] = (1 - cs) / a0; c[12] = c[10]; c[13] = (-2 * cs) / a0; c[14] = (1 - al) / a0;

    const A = Math.pow(10, shelfDb / 40), k = 2 * Math.sqrt(A) * (this.shelfSin / 2) * Math.SQRT2, s = this.shelfCos;
    const sa0 = (A + 1) + (A - 1) * s + k;
    c[15] = (A * ((A + 1) - (A - 1) * s + k)) / sa0;
    c[16] = (2 * A * ((A - 1) - (A + 1) * s)) / sa0;
    c[17] = (A * ((A + 1) - (A - 1) * s - k)) / sa0;
    c[18] = (-2 * ((A - 1) + (A + 1) * s)) / sa0;
    c[19] = ((A + 1) + (A - 1) * s - k) / sa0;
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0];
    const L = out[0], R = out.length > 1 ? out[1] : null;
    const len = L.length;

    const tCut = Math.log(parameters.cutoff[0]), tShelf = parameters.shelfDb[0], tMake = parameters.makeup[0];
    const tVol = parameters.volume[0], tSwell = parameters.swell[0], tWidth = parameters.width[0];
    if (!this.ready) {
      this.sCut = tCut; this.sShelf = tShelf; this.sMake = tMake; this.sVol = tVol; this.sSwell = tSwell; this.sWidth = tWidth;
      this.ready = true;
    }

    const ks = this.ks, p = this.p, g = this.g, c = this.c, z = this.z;
    let a = this.a | 0, b = this.b | 0, yL = this.yL, yR = this.yR;
    let sCut = this.sCut, sShelf = this.sShelf, sMake = this.sMake, sVol = this.sVol, sSwell = this.sSwell, sWidth = this.sWidth;
    let phA = this.phA, phB = this.phB, n = this.n, sCor = this.sCor, sInd = this.sInd;

    for (let i = 0; i < len; i++) {
      sCut += ks * (tCut - sCut); sShelf += ks * (tShelf - sShelf); sMake += ks * (tMake - sMake);
      sVol += ks * (tVol - sVol); sSwell += ks * (tSwell - sSwell); sWidth += ks * (tWidth - sWidth);
      phA += this.dA; if (phA > TWO_PI) phA -= TWO_PI;
      phB += this.dB; if (phB > TWO_PI) phB -= TWO_PI;

      if ((n++ & 7) === 0) {
        const cents = sSwell * (0.65 * Math.sin(phA) + 0.35 * Math.sin(phB));
        this.setCoeffs(sCut + (cents * LN2) / 1200, sShelf);
        sInd = sWidth; sCor = Math.sqrt(1 - sWidth * sWidth);
      }

      // two independent brown noise channels (xorshift32 -> leaky integrator)
      a ^= a << 13; a ^= a >>> 17; a ^= a << 5;
      b ^= b << 13; b ^= b >>> 17; b ^= b << 5;
      yL = p * yL + g * ((a >>> 0) / 2147483648 - 1);
      yR = p * yR + g * ((b >>> 0) / 2147483648 - 1);
      let xL = yL, xR = sCor * yL + sInd * yR;

      // 4 biquad stages, transposed direct form II, per channel
      for (let s = 0, o = 0; s < 4; s++, o += 5) {
        const b0 = c[o], b1 = c[o + 1], b2 = c[o + 2], a1 = c[o + 3], a2 = c[o + 4];
        let zi = s * 2;
        let y = b0 * xL + z[zi]; z[zi] = b1 * xL - a1 * y + z[zi + 1]; z[zi + 1] = b2 * xL - a2 * y; xL = y;
        zi += 8;
        y = b0 * xR + z[zi]; z[zi] = b1 * xR - a1 * y + z[zi + 1]; z[zi + 1] = b2 * xR - a2 * y; xR = y;
      }

      // makeup, then a smooth limiter: identity below 0.7, glides to (but never reaches) 1.0
      xL *= sMake; xR *= sMake;
      let m = xL < 0 ? -xL : xL; if (m > 0.7) { m = 0.7 + 0.3 * Math.tanh((m - 0.7) / 0.3); xL = xL < 0 ? -m : m; }
      m = xR < 0 ? -xR : xR;     if (m > 0.7) { m = 0.7 + 0.3 * Math.tanh((m - 0.7) / 0.3); xR = xR < 0 ? -m : m; }

      L[i] = xL * sVol;
      if (R) R[i] = xR * sVol;
    }

    this.a = a; this.b = b; this.yL = yL; this.yR = yR;
    this.sCut = sCut; this.sShelf = sShelf; this.sMake = sMake; this.sVol = sVol; this.sSwell = sSwell; this.sWidth = sWidth;
    this.phA = phA; this.phB = phB; this.n = n; this.sCor = sCor; this.sInd = sInd;
    return true; // never stop
  }
}

registerProcessor('brown-noise', BrownNoiseProcessor);
