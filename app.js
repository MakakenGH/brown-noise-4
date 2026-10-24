/* Deep Brown: generator UI, audio engine and background-playback handling. */
'use strict';

(() => {
  const STORE_KEY = 'deepbrown:v1';
  const HINT_KEY = 'deepbrown:hint-seen';
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ *
   * Presets and state
   * ------------------------------------------------------------------ */
  const PRESETS = [
    { id: 'velvet',      name: 'Velvet',      deep: 0.50, rumble: 0.35, width: 0.60, swell: 0.10 },
    { id: 'deep-sleep',  name: 'Deep sleep',  deep: 0.78, rumble: 0.50, width: 0.70, swell: 0.15 },
    { id: 'abyss',       name: 'Abyss',       deep: 0.97, rumble: 0.75, width: 0.45, swell: 0.05 },
    { id: 'engine-room', name: 'Engine room', deep: 0.30, rumble: 0.60, width: 0.30, swell: 0.00 },
    { id: 'tide',        name: 'Tide',        deep: 0.62, rumble: 0.40, width: 0.90, swell: 0.65 },
    { id: 'focus',       name: 'Focus',       deep: 0.20, rumble: 0.15, width: 0.55, swell: 0.00 },
  ];
  const DEFAULTS = { deep: 0.50, rumble: 0.35, width: 0.60, swell: 0.10, volume: 0.55 };
  const KEYS = Object.keys(DEFAULTS);

  function loadState() {
    const s = { ...DEFAULTS };
    try {
      const o = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      for (const k of KEYS) if (typeof o[k] === 'number' && isFinite(o[k])) s[k] = clamp(o[k]);
    } catch (_) { /* private mode etc. */ }
    return s;
  }
  const S = loadState();
  let saveTimer = 0;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (_) {} }, 300);
  };

  /* ------------------------------------------------------------------ *
   * Sound mapping
   * ------------------------------------------------------------------ */
  const cutoffHz   = (d) => 900 * Math.pow(40 / 900, d);   // 900 Hz (shallow) to 40 Hz (abyss)
  const shelfDb    = (r) => r * 12;
  const swellCents = (s) => s * 700;
  const volumeGain = (v) => v * v;                          // audio taper
  const SHELF_HZ = 90, HP_HZ = 18, FADE_MS = 30000, TARGET_RMS = 0.14;

  /* Loudness model. Computes the RMS of the filtered noise from the filters'
   * exact frequency responses, so the output level stays constant while depth
   * and rumble change (instead of getting quieter as you go deeper). */
  function coeffs(type, f0, qDb, gDb, fs) {
    const w0 = (2 * Math.PI * f0) / fs, cos = Math.cos(w0), sin = Math.sin(w0);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lowpass' || type === 'highpass') {
      const alpha = sin / (2 * Math.pow(10, qDb / 20));
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      if (type === 'lowpass') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; }
      else { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; }
    } else { // lowshelf, slope 1
      const A = Math.pow(10, gDb / 40);
      const k = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2;
      b0 = A * ((A + 1) - (A - 1) * cos + k);
      b1 = 2 * A * ((A - 1) - (A + 1) * cos);
      b2 = A * ((A + 1) - (A - 1) * cos - k);
      a0 = (A + 1) + (A - 1) * cos + k;
      a1 = -2 * ((A - 1) + (A + 1) * cos);
      a2 = (A + 1) + (A - 1) * cos - k;
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  function mag2(c, w) {
    const cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = c[0] + c[1] * cw + c[2] * c2, ni = -(c[1] * sw + c[2] * s2);
    const dr = 1 + c[3] * cw + c[4] * c2, di = -(c[3] * sw + c[4] * s2);
    return (nr * nr + ni * ni) / (dr * dr + di * di);
  }
  const Q_BUTTER_DB = -3.0103;   // Web Audio lowpass/highpass Q is in dB
  const Q_LP2_DB = 1.5;
  function filterSet(cut, sDb, fs) {
    return [
      coeffs('highpass', HP_HZ, Q_BUTTER_DB, 0, fs),
      coeffs('lowpass', cut, Q_BUTTER_DB, 0, fs),
      coeffs('lowpass', cut, Q_LP2_DB, 0, fs),
      coeffs('lowshelf', SHELF_HZ, 0, sDb, fs),
    ];
  }
  function levelGain(cut, sDb, fs = 48000) {
    const set = filterSet(cut, sDb, fs);
    const a = Math.exp((-2 * Math.PI * 10) / fs);        // same leak as the worklet
    const N = 360, f0 = 0.1, f1 = fs / 2 * 0.999, dl = Math.log(f1 / f0) / (N - 1);
    let num = 0, den = 0;
    for (let i = 0; i < N; i++) {
      const f = f0 * Math.exp(i * dl), w = (2 * Math.PI * f) / fs;
      const psd = 1 / (1 - 2 * a * Math.cos(w) + a * a);
      let h = 1; for (const c of set) h *= mag2(c, w);
      num += psd * h * f; den += psd * f;
    }
    const rmsPre = 0.5 * Math.sqrt(num / den);
    return clamp(TARGET_RMS / rmsPre, 0.05, 14);
  }

  /* ------------------------------------------------------------------ *
   * Audio engine
   *
   * worklet (generator, filters, limiter: all on the audio thread, 64-bit floats)
   *   -> gate (play/pause fade) -> sleep fade -> output
   *
   * Output route:
   *   direct  straight to the audio output (cleanest). A silent, looping <audio>
   *           element runs alongside it so Android treats the page as media
   *           playback: lock-screen player, and it keeps running with the screen off.
   *   stream  routed through a MediaStream into the <audio> element. Same background
   *           behaviour, kept as a fallback in case direct is stopped by a device.
   * ------------------------------------------------------------------ */
  const ROUTE_KEY = 'deepbrown:route';

  function silentWavUrl() {              // 5 s, 8 kHz mono, +-1 LSB: inaudible but not digital zero
    const rate = 8000, n = rate * 5, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, ((Math.random() * 3) | 0) - 1, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  class Engine {
    constructor() {
      this.ctx = null; this.initP = null; this.busy = false; this.switching = false; this.token = 0;
      this.el = $('#sink'); this.silent = null; this.streamDest = null;
      let r = 'direct'; try { r = localStorage.getItem(ROUTE_KEY) === 'stream' ? 'stream' : 'direct'; } catch (_) {}
      this.route = r;
    }

    init() {
      if (!this.initP) this.initP = this._init().catch((e) => { this.initP = null; throw e; });
      return this.initP;
    }

    async _init() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !window.AudioWorkletNode) throw new Error('unsupported');
      const ctx = new AC({ latencyHint: 'playback' });   // largest buffers: fewest dropouts
      await ctx.audioWorklet.addModule('noise-processor.js');

      const node = new AudioWorkletNode(ctx, 'brown-noise', { numberOfInputs: 0, outputChannelCount: [2] });
      const gate = new GainNode(ctx, { gain: 0 });
      const sleepG = new GainNode(ctx, { gain: 1 });
      const analyser = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0 });
      node.connect(gate).connect(sleepG);
      sleepG.connect(analyser);                          // tap for the scope only

      Object.assign(this, { ctx, node, gate, sleepG, analyser });
      this.apply(S);
      this.setRoute(this.route);
      ctx.addEventListener('statechange', () => app.onContextState());
    }

    apply(s) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime, P = this.node.parameters;
      const cut = cutoffHz(s.deep), sDb = shelfDb(s.rumble);
      P.get('cutoff').setValueAtTime(cut, t);
      P.get('shelfDb').setValueAtTime(sDb, t);
      P.get('makeup').setValueAtTime(levelGain(cut, sDb, this.ctx.sampleRate), t);
      P.get('width').setValueAtTime(s.width, t);
      P.get('swell').setValueAtTime(swellCents(s.swell), t);
      P.get('volume').setValueAtTime(volumeGain(s.volume), t);   // smoothed per sample inside the worklet
    }

    setRoute(mode) {
      this.route = mode;
      try { localStorage.setItem(ROUTE_KEY, mode); } catch (_) {}
      if (!this.ctx) return;
      this.switching = true; setTimeout(() => { this.switching = false; }, 400);
      try { this.sleepG.disconnect(this.ctx.destination); } catch (_) {}
      if (this.streamDest) { try { this.sleepG.disconnect(this.streamDest); } catch (_) {} }
      const el = this.el;
      if (mode === 'stream') {
        if (!this.streamDest) this.streamDest = this.ctx.createMediaStreamDestination();
        this.sleepG.connect(this.streamDest);
        el.loop = false; el.removeAttribute('src'); el.srcObject = this.streamDest.stream;
      } else {
        this.sleepG.connect(this.ctx.destination);
        if (!this.silent) this.silent = silentWavUrl();
        el.srcObject = null; el.loop = true; el.src = this.silent;
      }
      if (app.wanted) el.play().catch(() => {});
    }

    async start() {
      const token = ++this.token;
      this.busy = true;
      try {
        await this.init();
        if (token !== this.token) return;
        const { ctx, gate, el } = this;
        this.apply(S);
        if (ctx.state !== 'running') await ctx.resume();
        const t = ctx.currentTime;
        gate.gain.cancelScheduledValues(t);
        gate.gain.setValueAtTime(0, t);
        gate.gain.linearRampToValueAtTime(1, t + 0.7);   // fade in: no click
        try { await el.play(); }
        catch (_) { if (this.route === 'stream') this.setRoute('direct'); }   // direct needs no element to make sound
      } finally { this.busy = false; }
    }

    async pause() {
      if (!this.ctx) return;
      const token = ++this.token;
      const { ctx, gate, el } = this;
      const t = ctx.currentTime;
      gate.gain.cancelScheduledValues(t);
      gate.gain.setValueAtTime(gate.gain.value, t);
      gate.gain.linearRampToValueAtTime(0, t + 0.25);
      await sleep(320);
      if (token !== this.token) return;                  // user pressed play again
      try { el.pause(); } catch (_) {}
      try { await ctx.suspend(); } catch (_) {}
      this.resetSleepFade();
    }

    sleepFade(remainingMs) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime, g = this.sleepG.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(clamp(remainingMs / FADE_MS), t);
      g.linearRampToValueAtTime(0, t + remainingMs / 1000);
    }
    resetSleepFade() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime, g = this.sleepG.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(1, t);
    }
  }
  const engine = new Engine();

  /* ------------------------------------------------------------------ *
   * Scope: the live waveform IS the depth line
   * ------------------------------------------------------------------ */
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const Y0 = 0.32, YSPAN = 0.52;               // depth line travels between 32% and 84% of the field
  const yOf = (d) => Y0 + YSPAN * d;

  class Scope {
    constructor(canvas) {
      this.c = canvas; this.g = canvas.getContext('2d');
      this.N = 72; this.pts = new Float32Array(this.N); this.hist = [];
      this.buf = new Float32Array(2048); this.peak = 0.05; this.lastHist = 0; this.last = 0; this.raf = 0; this.t0 = performance.now();
      this.resize();
      new ResizeObserver(() => { this.resize(); this.draw(); }).observe(canvas);
    }
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = this.c.clientWidth; this.h = this.c.clientHeight;
      this.c.width = Math.max(1, Math.round(this.w * dpr)); this.c.height = Math.max(1, Math.round(this.h * dpr));
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    run() { if (!this.raf && !reduceMotion) this.raf = requestAnimationFrame((t) => this.tick(t)); }
    halt() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; this.draw(); }
    tick(ts) {
      this.raf = requestAnimationFrame((t) => this.tick(t));
      if (ts - this.last < 33) return;                   // ~30 fps is plenty and kind to batteries
      this.last = ts; this.draw(ts);
    }
    sample(ts) {
      const N = this.N, live = app.wanted && engine.analyser && engine.ctx.state === 'running';
      if (live) {
        engine.analyser.getFloatTimeDomainData(this.buf);
        const step = this.buf.length / N; let mx = 0;
        const next = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          let s = 0; for (let j = 0; j < step; j++) s += this.buf[(i * step + j) | 0];
          next[i] = s / step; mx = Math.max(mx, Math.abs(next[i]));
        }
        this.peak = Math.max(this.peak * 0.995, mx, 0.02);
        for (let i = 0; i < N; i++) this.pts[i] = lerp(this.pts[i], clamp(next[i] / this.peak, -1, 1), 0.55);
      } else {
        const t = (ts || this.t0) / 1000;
        for (let i = 0; i < N; i++) {
          const x = i / N;
          this.pts[i] = lerp(this.pts[i], 0.18 * Math.sin(x * 6.28 * 1.3 + t * 0.4) + 0.08 * Math.sin(x * 6.28 * 3.1 - t * 0.25), 0.1);
        }
      }
    }
    path(g, y0, amp, dy = 0) {
      const { N, pts, w } = this, dx = w / (N - 1);
      g.beginPath(); g.moveTo(0, y0 + dy + pts[0] * amp);
      for (let i = 1; i < N; i++) {
        const x = i * dx, px = (i - 1) * dx, mx = (x + px) / 2, my = y0 + dy + ((pts[i] + pts[i - 1]) / 2) * amp;
        g.quadraticCurveTo(px, y0 + dy + pts[i - 1] * amp, mx, my);
      }
      g.lineTo(w, y0 + dy + pts[N - 1] * amp);
    }
    draw(ts) {
      const g = this.g, { w, h } = this;
      if (!w || !h) return;
      g.clearRect(0, 0, w, h);
      this.sample(ts);
      const y0 = yOf(S.deep) * h, amp = h * 0.07;

      if (ts && ts - this.lastHist > 380) {              // ghost layers: recent past, drifting down
        this.hist.unshift(Float32Array.from(this.pts)); this.hist.length = Math.min(this.hist.length, 3); this.lastHist = ts;
      }
      // below the line: the dark
      this.path(g, y0, amp); g.lineTo(w, h); g.lineTo(0, h); g.closePath();
      g.fillStyle = 'rgba(6,4,3,0.42)'; g.fill();

      const live = this.pts; g.lineJoin = 'round'; g.lineCap = 'round';
      for (let k = this.hist.length - 1; k >= 0; k--) {
        this.pts = this.hist[k];
        this.path(g, y0, amp, (k + 1) * 9);
        g.strokeStyle = `rgba(240,226,207,${0.20 - k * 0.055})`; g.lineWidth = 1.5; g.stroke();
      }
      this.pts = live;
      this.path(g, y0, amp);
      g.strokeStyle = '#86d1c0'; g.lineWidth = 2.5; g.stroke();

      // scale on the right edge, with the handle at the current depth
      g.font = '12px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
      for (const p of [0, 0.25, 0.5, 0.75, 1]) {
        const y = yOf(p) * h; g.fillStyle = 'rgba(240,226,207,0.38)'; g.fillRect(w - 20, y - 0.5, 10, 1);
      }
      g.fillStyle = 'rgba(240,226,207,0.62)';
      g.fillText('Shallow', w - 28, yOf(0) * h); g.fillText('Deep', w - 28, yOf(1) * h);
      g.fillStyle = '#f0e2cf'; g.beginPath();
      if (g.roundRect) g.roundRect(w - 30, yOf(S.deep) * h - 2, 22, 4, 2); else g.rect(w - 30, yOf(S.deep) * h - 2, 22, 4);
      g.fill();
    }
  }
  const scope = new Scope($('#scope'));

  /* ------------------------------------------------------------------ *
   * App: state, rendering, playback control
   * ------------------------------------------------------------------ */
  const el = {
    field: $('#field'), deepNum: $('#deepNum'), deepHz: $('#deepHz'), hint: $('#hint'),
    play: $('#play'), playIcon: $('#playIcon'), status: $('#status'),
    presets: $('#presets'), timerBtns: $('#timerBtns'), timerLeft: $('#timerLeft'), install: $('#install'),
  };
  const PLAY_PATH = 'M8 5v14l11-7z';
  const PAUSE_PATH = 'M7 5h4v14H7zM13 5h4v14h-4z';
  const SLIDERS = ['rumble', 'width', 'swell', 'volume'];
  const mix = (a, b, t) => a.map((v, i) => Math.round(lerp(v, b[i], t)));
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

  const app = {
    wanted: false,
    timerEnd: 0,
    timerMin: 0,
    errorText: '',

    presetId() {
      const p = PRESETS.find((p) => ['deep', 'rumble', 'width', 'swell'].every((k) => Math.abs(S[k] - p[k]) < 0.006));
      return p ? p.id : null;
    },
    presetName() { const p = PRESETS.find((p) => p.id === this.presetId()); return p ? p.name : 'Custom'; },

    set(key, v) {
      S[key] = clamp(v);
      engine.apply(S);
      this.render(); save();
      if (key === 'deep') this.dismissHint();
      this.updateMediaSession();
    },
    applyPreset(id) {
      const p = PRESETS.find((p) => p.id === id); if (!p) return;
      for (const k of ['deep', 'rumble', 'width', 'swell']) S[k] = p[k];
      engine.apply(S); this.render(); save(); this.updateMediaSession();
    },
    stepPreset(dir) {
      const i = PRESETS.findIndex((p) => p.id === this.presetId());
      const n = i < 0 ? (dir > 0 ? 0 : PRESETS.length - 1) : (i + dir + PRESETS.length) % PRESETS.length;
      this.applyPreset(PRESETS[n].id);
    },
    dismissHint() { if (!el.hint.classList.contains('gone')) { el.hint.classList.add('gone'); try { localStorage.setItem(HINT_KEY, '1'); } catch (_) {} } },

    /* rendering */
    render() {
      const d = S.deep, cut = cutoffHz(d);
      el.field.style.setProperty('--top', rgb(mix([122, 77, 44], [38, 24, 16], d)));
      el.field.style.setProperty('--bottom', rgb(mix([32, 20, 13], [7, 4, 3], d)));
      el.deepNum.textContent = Math.round(d * 100);
      el.deepHz.textContent = `Rolls off above ${Math.round(cut / 5) * 5} Hz`;
      el.field.setAttribute('aria-valuenow', Math.round(d * 100));
      el.field.setAttribute('aria-valuetext', `${Math.round(d * 100)} percent, rolls off above ${Math.round(cut)} hertz`);
      for (const k of SLIDERS) {
        const input = $('#' + k), pct = Math.round(S[k] * 100);
        input.value = pct; input.style.setProperty('--p', pct + '%'); $('#' + k + 'Out').textContent = pct + '%';
      }
      const cur = this.presetId();
      for (const b of el.presets.children) b.setAttribute('aria-pressed', String(b.dataset.id === cur));
      this.renderPlay();
      scope.draw(performance.now());
    },
    renderPlay() {
      el.playIcon.firstElementChild.setAttribute('d', this.wanted ? PAUSE_PATH : PLAY_PATH);
      el.play.setAttribute('aria-label', this.wanted ? 'Pause' : 'Play');
      el.status.classList.toggle('err', !!this.errorText);
      el.status.textContent = this.errorText || (this.wanted ? `Playing ${this.presetName()}` : 'Paused');
    },
    renderTimer() {
      for (const b of el.timerBtns.children) b.setAttribute('aria-pressed', String(Number(b.dataset.min) === this.timerMin));
      if (!this.timerEnd) { el.timerLeft.textContent = ''; return; }
      const rem = Math.max(0, this.timerEnd - Date.now()), m = Math.floor(rem / 60000), s = Math.floor((rem % 60000) / 1000);
      el.timerLeft.textContent = rem >= 120000 ? `Stops in ${Math.ceil(rem / 60000)} min` : `Stops in ${m}:${String(s).padStart(2, '0')}`;
    },

    /* playback */
    async play() {
      if (this.wanted) return;
      this.wanted = true; this.errorText = ''; this.renderPlay(); scope.run();
      this.updateMediaSession();
      try { await engine.start(); }
      catch (e) {
        this.wanted = false;
        this.errorText = e && e.message === 'unsupported'
          ? "This browser can't run the audio engine. Try Chrome." : 'Audio could not start. Tap play to try again.';
        this.renderPlay(); scope.halt(); this.updateMediaSession();
      }
    },
    pause() {
      if (!this.wanted) return;
      this.wanted = false; this.clearTimer(); this.renderPlay(); scope.halt();
      engine.pause(); this.updateMediaSession();
    },
    toggle() { this.wanted ? this.pause() : this.play(); },

    /* keep alive */
    recover() {
      if (!this.wanted || !engine.ctx || engine.busy) return;
      if (engine.ctx.state !== 'running') engine.ctx.resume().catch(() => {});
      if (engine.el.paused) engine.el.play().catch(() => {});
    },
    onContextState() { if (this.wanted && engine.ctx.state !== 'running') this.recover(); },
    onElementPause() {          // paused by the system (call, headphones unplugged): respect it
      if (!this.wanted || engine.busy || engine.switching) return;
      this.wanted = false; this.clearTimer(); this.renderPlay(); scope.halt();
      engine.pause(); this.updateMediaSession();
    },

    /* sleep timer */
    setTimer(min) {
      this.timerMin = min; this.timerEnd = min ? Date.now() + min * 60000 : 0;
      engine.resetSleepFade(); this.renderTimer();
    },
    clearTimer() { this.timerMin = 0; this.timerEnd = 0; this.renderTimer(); },   // engine.pause() resets the fade after the output is silent
    tick() {
      if (this.timerEnd) {
        const rem = this.timerEnd - Date.now();
        if (rem <= 0) { this.pause(); return; }
        if (rem <= FADE_MS && this.wanted) engine.sleepFade(rem);   // re-anchored every second
        this.renderTimer();
      }
      this.recover();                                               // watchdog
    },

    /* lock-screen / notification player */
    updateMediaSession() {
      if (!('mediaSession' in navigator)) return;
      const ms = navigator.mediaSession;
      try {
        ms.metadata = new MediaMetadata({
          title: 'Deep brown noise', artist: this.presetName(), album: 'Deep Brown',
          artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
        });
        ms.playbackState = this.wanted ? 'playing' : 'paused';
      } catch (_) {}
    },
    initMediaSession() {
      if (!('mediaSession' in navigator)) return;
      const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (_) {} };
      h('play', () => this.play()); h('pause', () => this.pause()); h('stop', () => this.pause());
      h('previoustrack', () => this.stepPreset(-1)); h('nexttrack', () => this.stepPreset(1));
    },
  };

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */
  // presets
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'chip'; b.type = 'button'; b.dataset.id = p.id; b.textContent = p.name;
    b.addEventListener('click', () => app.applyPreset(p.id));
    el.presets.appendChild(b);
  }
  // timer
  for (const [min, label] of [[0, 'Off'], [15, '15 min'], [30, '30 min'], [60, '60 min'], [90, '90 min']]) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.min = min; b.textContent = label;
    b.addEventListener('click', () => app.setTimer(min));
    el.timerBtns.appendChild(b);
  }
  // output route
  const routeBtns = $('#routeBtns');
  const renderRoute = () => { for (const b of routeBtns.children) b.setAttribute('aria-pressed', String(b.dataset.mode === engine.route)); };
  for (const b of routeBtns.children) b.addEventListener('click', () => { engine.setRoute(b.dataset.mode); renderRoute(); });
  renderRoute();
  // sliders
  for (const k of SLIDERS) $('#' + k).addEventListener('input', (e) => app.set(k, e.target.value / 100));
  // transport
  el.play.addEventListener('click', () => app.toggle());
  $('#prev').addEventListener('click', () => app.stepPreset(-1));
  $('#next').addEventListener('click', () => app.stepPreset(1));

  // depth field: the line follows the finger 1:1
  let drag = null;
  el.field.addEventListener('pointerdown', (e) => {
    el.field.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, v: S.deep, h: el.field.clientHeight };
  });
  el.field.addEventListener('pointermove', (e) => {
    if (drag) app.set('deep', drag.v + (e.clientY - drag.y) / (drag.h * YSPAN));
  });
  for (const ev of ['pointerup', 'pointercancel']) el.field.addEventListener(ev, () => { drag = null; });
  el.field.addEventListener('wheel', (e) => { e.preventDefault(); app.set('deep', S.deep + e.deltaY * 0.0006); }, { passive: false });
  el.field.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 0.05 : 0.01;
    const map = { ArrowDown: big, ArrowRight: big, ArrowUp: -big, ArrowLeft: -big, PageDown: 0.1, PageUp: -0.1 };
    if (e.key in map) { e.preventDefault(); app.set('deep', S.deep + map[e.key]); }
    else if (e.key === 'Home') { e.preventDefault(); app.set('deep', 0); }
    else if (e.key === 'End') { e.preventDefault(); app.set('deep', 1); }
  });

  // keep playing: recover when the page comes back, and when the system or browser interferes
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { app.recover(); scope.draw(performance.now()); } });
  $('#sink').addEventListener('pause', () => app.onElementPause());
  $('#sink').addEventListener('error', () => app.recover());
  setInterval(() => app.tick(), 1000);

  // install prompt
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; el.install.hidden = false; });
  el.install.addEventListener('click', async () => {
    if (!deferred) return; deferred.prompt(); await deferred.userChoice.catch(() => {}); deferred = null; el.install.hidden = true;
  });
  window.addEventListener('appinstalled', () => { el.install.hidden = true; });

  // offline shell
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));

  try { if (localStorage.getItem(HINT_KEY)) el.hint.classList.add('gone'); } catch (_) {}
  app.initMediaSession();
  app.render(); app.renderTimer();
})();
