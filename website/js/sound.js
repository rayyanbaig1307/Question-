// All sound is made here in code, and nothing plays until "Enable sound" is clicked.
// A quiet airy pad, a glassy "tink" when two drops touch, a soft swish while you hold to reveal.

export class Sound {
  constructor() {
    this.ctx = null;
    this.on = false;
    this.lastTink = 0;
  }

  async toggle() {
    if (!this.ctx) this.start();
    this.on = !this.on;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.on ? 0.55 : 0, t, 0.25);
    return this.on;
  }

  start() {
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    // a short glassy room
    const rev = ctx.createConvolver();
    const len = ctx.sampleRate * 2.4;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    rev.buffer = ir;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.35;
    rev.connect(this.wet).connect(this.master);
    this.dry = ctx.createGain();
    this.dry.connect(this.master);
    this.dry.connect(rev);
    this.master.connect(ctx.destination);

    // the pad: soft chord, slowly breathing
    const pad = ctx.createGain();
    pad.gain.value = 0.05;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    pad.connect(lp).connect(this.dry);
    for (const [f, d] of [[220, -4], [277.18, 3], [329.63, -2], [440, 5]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.detune.value = d;
      const g = ctx.createGain();
      g.gain.value = 0.25;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.05 + Math.random() * 0.08;
      const lg = ctx.createGain();
      lg.gain.value = 0.18;
      lfo.connect(lg).connect(g.gain);
      o.connect(g).connect(pad);
      o.start();
      lfo.start();
    }
    // breath noise for the hold swish
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = nb;
    noise.loop = true;
    this.swishFilter = ctx.createBiquadFilter();
    this.swishFilter.type = 'bandpass';
    this.swishFilter.frequency.value = 1800;
    this.swishFilter.Q.value = 0.8;
    this.swishGain = ctx.createGain();
    this.swishGain.gain.value = 0;
    noise.connect(this.swishFilter).connect(this.swishGain).connect(this.dry);
    noise.start();
  }

  tink(size = 0.1) {
    if (!this.on || !this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    if (t - this.lastTink < 0.12) return;
    this.lastTink = t;
    const notes = [1046.5, 1174.7, 1318.5, 1568, 1760, 2093];
    const f = notes[Math.floor(Math.random() * notes.length)] * (size > 0.15 ? 0.5 : 1);
    for (const [mul, amp, decay] of [[1, 0.14, 1.4], [2.76, 0.05, 0.5], [5.4, 0.02, 0.25]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mul;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      o.connect(g).connect(this.dry);
      o.start(t);
      o.stop(t + decay + 0.05);
    }
  }

  tick() {
    if (!this.on || !this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(2400, t);
    o.frequency.exponentialRampToValueAtTime(1600, t + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.03, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.connect(g).connect(this.dry);
    o.start(t);
    o.stop(t + 0.1);
  }

  swish(on) {
    if (!this.on || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.swishGain.gain.setTargetAtTime(on ? 0.06 : 0, t, on ? 0.08 : 0.25);
    this.swishFilter.frequency.setTargetAtTime(on ? 2600 : 1200, t, 0.4);
  }
}
