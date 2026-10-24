'use strict';

/* ===================================================================
   Deep Noise — App Controller
   Audio engine  ·  Visualizer  ·  UI  ·  PWA bootstrap
   =================================================================== */

// ── Presets ────────────────────────────────────────────────────────
const PRESETS = [
  { name: 'Deep Sleep',  emoji: '🌙', depth: 85,  rumble: 60, volume: 35 },
  { name: 'Focus',       emoji: '🎯', depth: 50,  rumble: 25, volume: 30 },
  { name: 'Meditation',  emoji: '🧘', depth: 70,  rumble: 45, volume: 25 },
  { name: 'Thunder',     emoji: '⛈️',  depth: 95,  rumble: 85, volume: 45 },
  { name: 'Warm',        emoji: '☕', depth: 55,  rumble: 40, volume: 35 },
  { name: 'Abyss',       emoji: '🕳️', depth: 100, rumble: 95, volume: 30 },
];

// ── Audio Engine ──────────────────────────────────────────────────
class DeepNoiseEngine {
  constructor() {
    this.ctx = null;           // AudioContext
    this.ready = false;
    this.playing = false;

    // Stored parameter values (0-100 each)
    this.depth  = 70;
    this.rumble = 50;
    this.volume = 40;

    // Nodes (created lazily)
    this.noise       = null;   // AudioWorkletNode
    this.lp1         = null;   // BiquadFilter  lowpass  (depth)
    this.lp2         = null;   // BiquadFilter  lowpass  (depth, 2nd stage)
    this.shelf       = null;   // BiquadFilter  lowshelf (rumble)
    this.gain        = null;   // GainNode      (volume)
    this.analyser    = null;   // AnalyserNode  (visualizer)
    this.msDest      = null;   // MediaStreamDestination (bg playback)
  }

  /* ── Lazy initialisation (requires user gesture) ────────────── */
  async init() {
    if (this.ready) return;

    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'playback', sampleRate: 44100 });

    // Load the worklet processor
    if (this.ctx.audioWorklet) {
      await this.ctx.audioWorklet.addModule('noise-worklet.js');
      this.noise = new AudioWorkletNode(this.ctx, 'deep-noise-processor', {
        outputChannelCount: [2],
        numberOfOutputs: 1,
      });
    } else {
      // Fallback for browsers without AudioWorklet (very old)
      this.noise = this._fallbackProcessor();
    }

    // Two cascaded 2nd-order Butterworth low-pass → 24 dB/oct rolloff
    this.lp1 = this.ctx.createBiquadFilter();
    this.lp1.type = 'lowpass';
    this.lp1.Q.value = 0.707;

    this.lp2 = this.ctx.createBiquadFilter();
    this.lp2.type = 'lowpass';
    this.lp2.Q.value = 0.707;

    // Low-shelf to boost the sub-bass ("Rumble")
    this.shelf = this.ctx.createBiquadFilter();
    this.shelf.type = 'lowshelf';
    this.shelf.frequency.value = 80;

    // Master gain
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;   // start silent — faded in on play()

    // Analyser for the visualizer
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.82;

    // MediaStream destination → feeds the hidden <audio> element so
    // Chrome on Android keeps the audio session alive in the background.
    this.msDest = this.ctx.createMediaStreamDestination();

    // Wire up the graph
    this.noise.connect(this.lp1);
    this.lp1.connect(this.lp2);
    this.lp2.connect(this.shelf);
    this.shelf.connect(this.gain);
    this.gain.connect(this.ctx.destination);
    this.gain.connect(this.msDest);
    this.gain.connect(this.analyser);

    // Point the hidden <audio> at the MediaStream
    const el = document.getElementById('bgAudio');
    el.srcObject = this.msDest.stream;

    // Apply stored parameters
    this._applyDepth(this.depth);
    this._applyRumble(this.rumble);

    // Keep the context alive when Android tries to suspend it
    this.ctx.addEventListener('statechange', () => {
      if (this.playing && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    });

    this.ready = true;
  }

  /* ── Fallback noise generator (ScriptProcessorNode) ─────────── */
  _fallbackProcessor() {
    const sp = this.ctx.createScriptProcessor(4096, 0, 2);
    const b = [0, 0], dxP = [0, 0], dyP = [0, 0];
    sp.onaudioprocess = (e) => {
      for (let ch = 0; ch < 2; ch++) {
        const out = e.outputBuffer.getChannelData(ch);
        for (let i = 0; i < out.length; i++) {
          b[ch] = b[ch] * 0.999 + (Math.random() * 2 - 1) * 0.02;
          let s = Math.tanh(b[ch] * 2.5);
          const y = s - dxP[ch] + 0.9975 * dyP[ch];
          dxP[ch] = s; dyP[ch] = y;
          out[i] = y;
        }
      }
    };
    return sp;
  }

  /* ── Parameter helpers ──────────────────────────────────────── */
  _depthToFreq(d) {
    // 0 → 1000 Hz  (standard brown noise)
    // 100 → 20 Hz  (extreme sub-bass)
    return 1000 * Math.pow(0.02, d / 100);
  }

  _applyDepth(d) {
    const f = Math.max(this._depthToFreq(d), 1);   // must be > 0 for exp ramp
    const t = this.ctx.currentTime;
    for (const lp of [this.lp1, this.lp2]) {
      lp.frequency.cancelScheduledValues(0);
      lp.frequency.setValueAtTime(lp.frequency.value, t);
      lp.frequency.exponentialRampToValueAtTime(f, t + 0.08);
    }
  }

  _applyRumble(r) {
    const dB = r * 0.2;   // 0-100 → 0-20 dB boost
    const t = this.ctx.currentTime;
    this.shelf.gain.cancelScheduledValues(0);
    this.shelf.gain.setValueAtTime(this.shelf.gain.value, t);
    this.shelf.gain.linearRampToValueAtTime(dB, t + 0.08);
  }

  _applyVolume(v) {
    const g = Math.pow(v / 100, 2);   // perceptual curve
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(0);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(g, t + 0.08);
  }

  /* ── Public parameter setters ───────────────────────────────── */
  setDepth(v)  { this.depth  = v; if (this.ready) this._applyDepth(v); }
  setRumble(v) { this.rumble = v; if (this.ready) this._applyRumble(v); }
  setVolume(v) { this.volume = v; if (this.ready && this.playing) this._applyVolume(v); }

  /* ── Transport ──────────────────────────────────────────────── */
  async play() {
    if (!this.ready) await this.init();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.playing = true;

    // Smooth fade-in
    this._applyVolume(this.volume);

    // Drive the <audio> element so Android keeps the session alive
    const el = document.getElementById('bgAudio');
    try { await el.play(); } catch (_) { /* non-fatal */ }

    this._setupMediaSession();
  }

  pause() {
    if (!this.ready || !this.playing) return;
    this.playing = false;

    // Smooth fade-out
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(0);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(0, t + 0.12);

    const el = document.getElementById('bgAudio');
    el.pause();

    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  /* ── Media Session (Android notification controls) ──────────── */
  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title:  'Deep Brown Noise',
      artist: 'Deep Noise',
      album:  'Ambient',
    });

    navigator.mediaSession.playbackState = 'playing';
    navigator.mediaSession.setActionHandler('play',  () => this.play());
    navigator.mediaSession.setActionHandler('pause', () => this.pause());
    navigator.mediaSession.setActionHandler('stop',  () => this.pause());
  }

  /* ── Analyser data (for visualizer) ─────────────────────────── */
  getFrequencyData() {
    if (!this.analyser) return null;
    const d = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(d);
    return d;
  }
}

// ── Visualizer ────────────────────────────────────────────────────
class Visualizer {
  constructor(canvas, engine) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.engine  = engine;
    this.animId  = null;
    this.smoothed = null;
    this.phase   = 0;          // idle animation phase
    this.active  = false;      // true while audio is playing

    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvas.parentElement);
  }

  _resize() {
    const r   = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width  = r.width  * dpr;
    this.canvas.height = r.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width;
    this.h = r.height;
  }

  start()   { if (!this.animId) this._loop(); }
  stop()    { cancelAnimationFrame(this.animId); this.animId = null; }
  setActive(a) { this.active = a; }

  _loop() {
    this._draw();
    this.animId = requestAnimationFrame(() => this._loop());
  }

  _draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    this.active ? this._drawSpectrum(ctx, w, h)
                : this._drawIdle(ctx, w, h);
  }

  /* ── Live frequency spectrum ──────────────────────────────── */
  _drawSpectrum(ctx, w, h) {
    const data = this.engine.getFrequencyData();
    if (!data) return;

    const N = 48;                          // bins to show
    if (!this.smoothed) this.smoothed = new Float32Array(N);

    for (let i = 0; i < N; i++) {
      const t = (data[i] || 0) / 255;
      this.smoothed[i] += (t - this.smoothed[i]) * 0.12;
    }

    // Filled curve
    ctx.beginPath();
    ctx.moveTo(0, h);

    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * w;
      const y = h - this.smoothed[i] * h * 0.82;
      if (i === 0) {
        ctx.lineTo(x, y);
      } else {
        const px = ((i - 1) / (N - 1)) * w;
        const py = h - this.smoothed[i - 1] * h * 0.82;
        const mx = (px + x) / 2;
        ctx.bezierCurveTo(mx, py, mx, y, x, y);
      }
    }
    ctx.lineTo(w, h);
    ctx.closePath();

    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0,   'rgba(200,149,106,0.28)');
    g.addColorStop(0.5, 'rgba(200,149,106,0.08)');
    g.addColorStop(1,   'rgba(200,149,106,0.01)');
    ctx.fillStyle = g;
    ctx.fill();

    // Thin top stroke
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * w;
      const y = h - this.smoothed[i] * h * 0.82;
      if (i === 0) { ctx.moveTo(x, y); continue; }
      const px = ((i - 1) / (N - 1)) * w;
      const py = h - this.smoothed[i - 1] * h * 0.82;
      const mx = (px + x) / 2;
      ctx.bezierCurveTo(mx, py, mx, y, x, y);
    }
    ctx.strokeStyle = 'rgba(200,149,106,0.45)';
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  }

  /* ── Idle ambient wave ────────────────────────────────────── */
  _drawIdle(ctx, w, h) {
    this.phase += 0.008;
    const SEG = 80;

    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i <= SEG; i++) {
      const x = (i / SEG) * w;
      const wave = Math.sin(this.phase + i * 0.08) * 0.025
                 + Math.sin(this.phase * 0.6 + i * 0.04) * 0.015;
      const y = h * 0.88 + wave * h;
      if (i === 0) ctx.lineTo(x, y);
      else         ctx.lineTo(x, y);   // simple lines are fine for idle
    }
    ctx.lineTo(w, h);
    ctx.closePath();

    const g = ctx.createLinearGradient(0, h * 0.7, 0, h);
    g.addColorStop(0, 'rgba(200,149,106,0.06)');
    g.addColorStop(1, 'rgba(200,149,106,0.015)');
    ctx.fillStyle = g;
    ctx.fill();
  }
}

// ── App Controller ────────────────────────────────────────────────
class App {
  constructor() {
    this.engine  = new DeepNoiseEngine();
    this.vis     = null;
    this.preset  = null;       // currently active preset name
    this._saveTimer = null;

    this._bindUI();
    this._renderPresets();
    this._loadSettings();
    this._initVisualizer();
    this._registerSW();
    this._bindGlobal();
  }

  /* ── UI element references ──────────────────────────────────── */
  _bindUI() {
    this.els = {
      play:   document.getElementById('playBtn'),
      depth:  document.getElementById('depth'),
      rumble: document.getElementById('rumble'),
      volume: document.getElementById('volume'),
      grid:   document.getElementById('presetGrid'),
      depthV: document.getElementById('depthValue'),
      rumbleV:document.getElementById('rumbleValue'),
      volumeV:document.getElementById('volumeValue'),
      iconPlay:  document.querySelector('.icon-play'),
      iconPause: document.querySelector('.icon-pause'),
    };

    this.els.play.addEventListener('click', () => this._toggle());

    const bind = (slider, setter, display) => {
      // Update on every input event (thumb drag)
      slider.addEventListener('input', () => {
        const v = +slider.value;
        setter(v);
        display.textContent = `${v} %`;
        this._fillSlider(slider);
        this._clearPreset();
        this._debouncedSave();
      });
      this._fillSlider(slider);
    };

    bind(this.els.depth,  (v) => this.engine.setDepth(v),  this.els.depthV);
    bind(this.els.rumble, (v) => this.engine.setRumble(v), this.els.rumbleV);
    bind(this.els.volume, (v) => this.engine.setVolume(v), this.els.volumeV);
  }

  /* ── Presets grid ───────────────────────────────────────────── */
  _renderPresets() {
    const frag = document.createDocumentFragment();
    for (const p of PRESETS) {
      const btn = document.createElement('button');
      btn.className = 'preset-btn';
      btn.dataset.name = p.name;
      btn.innerHTML = `<span class="preset-emoji">${p.emoji}</span>${p.name}`;
      btn.addEventListener('click', () => this._applyPreset(p));
      frag.appendChild(btn);
    }
    this.els.grid.appendChild(frag);
  }

  _applyPreset(p) {
    this.preset = p.name;

    // Animate sliders to target values
    this._animSlider(this.els.depth,  p.depth);
    this._animSlider(this.els.rumble, p.rumble);
    this._animSlider(this.els.volume, p.volume);

    // Push values to engine
    this.engine.setDepth(p.depth);
    this.engine.setRumble(p.rumble);
    this.engine.setVolume(p.volume);

    // Update displays
    this.els.depthV.textContent  = `${p.depth} %`;
    this.els.rumbleV.textContent = `${p.rumble} %`;
    this.els.volumeV.textContent = `${p.volume} %`;

    this._highlightPreset(p.name);
    this._debouncedSave();
  }

  _highlightPreset(name) {
    this.els.grid.querySelectorAll('.preset-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.name === name);
    });
  }

  _clearPreset() {
    this.preset = null;
    this.els.grid.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
  }

  /* ── Slider animation ──────────────────────────────────────── */
  _animSlider(slider, target) {
    const from = +slider.value;
    const dist = target - from;
    if (dist === 0) return;
    const FRAMES = 18;
    let f = 0;
    const step = () => {
      f++;
      const t = f / FRAMES;
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      slider.value = Math.round(from + dist * ease);
      this._fillSlider(slider);
      if (f < FRAMES) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _fillSlider(slider) {
    slider.style.setProperty('--val', slider.value);
  }

  /* ── Play / pause ───────────────────────────────────────────── */
  async _toggle() {
    if (this.engine.playing) {
      this.engine.pause();
      this._setPlayUI(false);
    } else {
      await this.engine.play();
      this._setPlayUI(true);
    }
  }

  _setPlayUI(playing) {
    this.els.play.classList.toggle('playing', playing);
    this.els.iconPlay.style.display  = playing ? 'none' : '';
    this.els.iconPause.style.display = playing ? ''     : 'none';
    if (this.vis) this.vis.setActive(playing);
  }

  /* ── Visualizer ─────────────────────────────────────────────── */
  _initVisualizer() {
    const canvas = document.getElementById('visualizer');
    this.vis = new Visualizer(canvas, this.engine);
    this.vis.start();

    // Pause rendering when the tab is hidden (save battery)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.vis.stop();
      } else {
        this.vis.start();
        // Ensure audio stays alive
        if (this.engine.playing && this.engine.ctx &&
            this.engine.ctx.state === 'suspended') {
          this.engine.ctx.resume().catch(() => {});
        }
      }
    });
  }

  /* ── Persistence ────────────────────────────────────────────── */
  _saveSettings() {
    try {
      localStorage.setItem('deepnoise', JSON.stringify({
        depth:  +this.els.depth.value,
        rumble: +this.els.rumble.value,
        volume: +this.els.volume.value,
        preset: this.preset,
      }));
    } catch (_) { /* storage full or unavailable */ }
  }

  _debouncedSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._saveSettings(), 400);
  }

  _loadSettings() {
    try {
      const raw = localStorage.getItem('deepnoise');
      if (!raw) return;
      const s = JSON.parse(raw);

      this.els.depth.value  = s.depth;
      this.els.rumble.value = s.rumble;
      this.els.volume.value = s.volume;

      this.engine.depth  = s.depth;
      this.engine.rumble = s.rumble;
      this.engine.volume = s.volume;

      this.els.depthV.textContent  = `${s.depth} %`;
      this.els.rumbleV.textContent = `${s.rumble} %`;
      this.els.volumeV.textContent = `${s.volume} %`;

      [this.els.depth, this.els.rumble, this.els.volume].forEach((sl) =>
        this._fillSlider(sl));

      if (s.preset) {
        this.preset = s.preset;
        this._highlightPreset(s.preset);
      }
    } catch (_) { /* corrupt data – use defaults */ }
  }

  /* ── Global keyboard shortcuts ──────────────────────────────── */
  _bindGlobal() {
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space') { e.preventDefault(); this._toggle(); }
    });
  }

  /* ── Service worker registration ────────────────────────────── */
  _registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => new App());
