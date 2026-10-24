/**
 * Deep Brown Noise — AudioWorklet Processor
 *
 * Generates stereo brown noise via leaky integration of white noise,
 * followed by soft-limiting (tanh) and a DC-blocking filter.
 * All frequency shaping is handled by native BiquadFilterNodes in the
 * main audio graph for maximum efficiency and zero-glitch operation.
 */
class DeepNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Per-channel state (stereo)
    this.brown = new Float64Array(2);
    this.dcPrevIn = new Float64Array(2);
    this.dcPrevOut = new Float64Array(2);
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const numCh = Math.min(output.length, 2);

    for (let ch = 0; ch < numCh; ch++) {
      const buf = output[ch];
      let b = this.brown[ch];
      let dxPrev = this.dcPrevIn[ch];
      let dyPrev = this.dcPrevOut[ch];

      for (let i = 0; i < buf.length; i++) {
        // White noise source
        const white = Math.random() * 2 - 1;

        // Leaky integrator  →  brown noise
        // leak = 0.999  keeps energy finite (prevents DC runaway)
        // step = 0.02   controls integration rate / spectral slope
        b = b * 0.999 + white * 0.02;

        // Soft-limit via tanh so peaks compress gently (no hard clips)
        let s = Math.tanh(b * 2.5);

        // First-order DC blocker  (high-pass ≈ 5 Hz at 44.1 kHz)
        //   y[n] = x[n] − x[n-1] + R·y[n-1],  R ≈ 0.9975
        const y = s - dxPrev + 0.9975 * dyPrev;
        dxPrev = s;
        dyPrev = y;

        buf[i] = y;
      }

      this.brown[ch] = b;
      this.dcPrevIn[ch] = dxPrev;
      this.dcPrevOut[ch] = dyPrev;
    }

    // Return true to keep the processor alive indefinitely
    return true;
  }
}

registerProcessor('deep-noise-processor', DeepNoiseProcessor);
