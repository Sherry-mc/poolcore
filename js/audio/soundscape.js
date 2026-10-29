/* ==========================================================================
   池核 · POOLCORE — 音景（Web Audio 实时合成）
   --------------------------------------------------------------------------
   四层声音，没有一个音频文件：
     · 水声    ：两路噪声过带通，带通频率与增益被慢速 LFO 推着走 —— 水拍池壁
     · 回声    ：噪声 + 指数衰减当场生成脉冲响应，喂给 ConvolverNode —— 空场
     · 灯管嗡鸣：50 / 100Hz 正弦叠一点锯齿，压得很低 —— 闭馆后那排灯
     · 远处滴水：随机调度的短正弦 + 快速下滑，送进混响
   切场景只改 AudioParam 的目标值并做 0.8s 平滑过渡，不重建节点（不会有爆音）。
   AudioContext 必须等首次用户手势之后才 resume()（浏览器自动播放策略）。
   ========================================================================== */

(function (root) {
  'use strict';

  var POOLCORE = root.POOLCORE = root.POOLCORE || {};

  /* 预设：每个场景的 audio 字段指到其中一个 */
  var PRESETS = {
    'indoor-hall': {
      label: '室内大厅',
      water: 0.5, waterHz: 620, waterQ: 0.7, waveRate: 0.11, waveDepth: 0.55,
      hum: 0.030, humHz: 50, humHarm: 0.4,
      rumble: 0.045, rumbleHz: 210,
      reverb: 2.6, reverbDecay: 2.4, wet: 0.5,
      dripRate: 7
    },
    'indoor-small': {
      label: '小池 · 回声短',
      water: 0.6, waterHz: 820, waterQ: 0.9, waveRate: 0.16, waveDepth: 0.6,
      hum: 0.024, humHz: 50, humHarm: 0.32,
      rumble: 0.03, rumbleHz: 300,
      reverb: 1.2, reverbDecay: 2.8, wet: 0.34,
      dripRate: 10
    },
    'indoor-deep': {
      label: '深水 · 压低',
      water: 0.42, waterHz: 420, waterQ: 0.55, waveRate: 0.07, waveDepth: 0.5,
      hum: 0.038, humHz: 50, humHarm: 0.55,
      rumble: 0.075, rumbleHz: 140,
      reverb: 3.6, reverbDecay: 2.1, wet: 0.6,
      dripRate: 4
    },
    'outdoor-open': {
      label: '户外 · 开阔',
      water: 0.58, waterHz: 900, waterQ: 0.6, waveRate: 0.2, waveDepth: 0.7,
      hum: 0.008, humHz: 50, humHarm: 0.2,
      rumble: 0.06, rumbleHz: 420,
      reverb: 0.9, reverbDecay: 3.4, wet: 0.22,
      dripRate: 3
    },
    'night-hum': {
      label: '夜里 · 灯管',
      water: 0.3, waterHz: 520, waterQ: 0.8, waveRate: 0.06, waveDepth: 0.45,
      hum: 0.062, humHz: 50, humHarm: 0.7,
      rumble: 0.035, rumbleHz: 180,
      reverb: 3.1, reverbDecay: 2.2, wet: 0.55,
      dripRate: 6
    },
    'flooded': {
      label: '进水 · 晃动',
      water: 0.62, waterHz: 480, waterQ: 0.5, waveRate: 0.24, waveDepth: 0.8,
      hum: 0.022, humHz: 50, humHarm: 0.3,
      rumble: 0.05, rumbleHz: 240,
      reverb: 2.2, reverbDecay: 2.5, wet: 0.46,
      dripRate: 12
    },
    'abandoned-drip': {
      label: '废弃 · 滴水',
      water: 0.16, waterHz: 380, waterQ: 0.5, waveRate: 0.04, waveDepth: 0.4,
      hum: 0.026, humHz: 50, humHarm: 0.45,
      rumble: 0.028, rumbleHz: 260,
      reverb: 1.8, reverbDecay: 3.0, wet: 0.55,
      dripRate: 22
    }
  };

  var ORDER = Object.keys(PRESETS);

  /* ---------- 噪声缓冲 ---------- */
  function noiseBuffer(ctx, seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) {
      var w = Math.random() * 2 - 1;
      last = last * 0.72 + w * 0.28;         // 一阶低通，去掉刺耳的高频
      d[i] = last * 1.6;
    }
    return buf;
  }

  /* ---------- 混响脉冲响应：噪声乘指数衰减 ---------- */
  function impulse(ctx, seconds, decay) {
    var len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    var buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      var lp = 0;
      for (var i = 0; i < len; i++) {
        var t = i / len;
        var n = Math.random() * 2 - 1;
        lp = lp * 0.62 + n * 0.38;
        d[i] = lp * Math.pow(1 - t, decay) * (1 - t * 0.15);
      }
    }
    return buf;
  }

  POOLCORE.createSoundscape = function () {
    var ctx = null, ready = false, failed = false;
    var master = null, wetGain = null, waterGain = null, humGain = null, rumbleGain = null;
    var waterFilter = null, humOsc2 = null, lfo = null, lfoGain = null, lfoGain2 = null;
    var waterSrc = null, waterSrc2 = null, rumbleSrc = null;
    var curName = 'indoor-hall';
    var muted = false, unlocked = false;
    var dripTimer = null;
    var lastIR = null;

    function init() {
      if (ready || failed) return ready;
      try {
        var AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) { failed = true; return false; }
        ctx = new AC();

        master = ctx.createGain();
        master.gain.value = 0.0;
        master.connect(ctx.destination);

        /* 混响支路 */
        wetGain = ctx.createGain();
        wetGain.gain.value = 0.4;
        wetGain.connect(master);

        /* 水声：噪声 → 带通 → 增益（增益被 LFO 推） */
        var nb = noiseBuffer(ctx, 4);
        waterFilter = ctx.createBiquadFilter();
        waterFilter.type = 'bandpass';
        waterFilter.frequency.value = 620;
        waterFilter.Q.value = 0.7;
        waterGain = ctx.createGain();
        waterGain.gain.value = 0.5;
        waterSrc = ctx.createBufferSource();
        waterSrc.buffer = nb; waterSrc.loop = true;
        waterSrc.connect(waterFilter);
        waterFilter.connect(waterGain);
        waterGain.connect(master);
        waterGain.connect(wetGain);

        /* 第二路水声：不同的带通，让水面有层次 */
        var bp2 = ctx.createBiquadFilter();
        bp2.type = 'bandpass';
        bp2.frequency.value = 1500;
        bp2.Q.value = 1.6;
        waterSrc2 = ctx.createBufferSource();
        waterSrc2.buffer = nb; waterSrc2.loop = true;
        lfoGain2 = ctx.createGain();
        lfoGain2.gain.value = 0.16;
        waterSrc2.connect(bp2);
        bp2.connect(lfoGain2);
        lfoGain2.connect(master);
        lfoGain2.connect(wetGain);

        /* 慢速 LFO：推水面（拍打感） */
        lfo = ctx.createOscillator();
        lfo.frequency.value = 0.11;
        lfoGain = ctx.createGain();
        lfoGain.gain.value = 220;
        lfo.connect(lfoGain);
        lfoGain.connect(waterFilter.frequency);

        /* 灯管嗡鸣：50Hz 基音 + 100Hz 泛音 */
        humGain = ctx.createGain();
        humGain.gain.value = 0.03;
        var humOsc = ctx.createOscillator();
        humOsc.type = 'sine';
        humOsc.frequency.value = 50;
        humOsc2 = ctx.createOscillator();
        humOsc2.type = 'triangle';
        humOsc2.frequency.value = 100;
        var hum2g = ctx.createGain();
        hum2g.gain.value = 0.4;
        humOsc.connect(humGain);
        humOsc2.connect(hum2g);
        hum2g.connect(humGain);
        humGain.connect(master);
        humGain.connect(wetGain);

        /* 空场底噪 */
        rumbleGain = ctx.createGain();
        rumbleGain.gain.value = 0.04;
        var rf = ctx.createBiquadFilter();
        rf.type = 'lowpass';
        rf.frequency.value = 210;
        rumbleSrc = ctx.createBufferSource();
        rumbleSrc.buffer = nb; rumbleSrc.loop = true;
        rumbleSrc.playbackRate.value = 0.6;
        rumbleSrc.connect(rf);
        rf.connect(rumbleGain);
        rumbleGain.connect(master);

        waterSrc.start(0);
        waterSrc2.start(0);
        lfo.start(0);
        humOsc.start(0);
        humOsc2.start(0);
        rumbleSrc.start(0);

        applyPreset(curName, 0.01);
        ready = true;
        return true;
      } catch (e) {
        failed = true;
        return false;
      }
    }

    /* 换一个预设的混响（只在长度差得明显时才重建 IR） */
    function ensureIR(name) {
      var ps = PRESETS[name] || PRESETS['indoor-hall'];
      if (lastIR === name) return;
      try {
        var conv = ctx.createConvolver();
        conv.buffer = impulse(ctx, ps.reverb, ps.reverbDecay);
        conv.connect(wetGain);
        /* 断掉旧的 */
        if (wetGain.__src) { try { wetGain.__src.disconnect(); } catch (e) {} }
        wetGain.__src = conv;
        /* 重新接线：wetGain 之前接的源 → conv */
        waterGain.disconnect(); waterGain.connect(master); waterGain.connect(conv);
        lfoGain2.disconnect(); lfoGain2.connect(master); lfoGain2.connect(conv);
        humGain.disconnect(); humGain.connect(master); humGain.connect(conv);
        lastIR = name;
      } catch (e) { /* 混响失败不影响其余层 */ }
    }

    function applyPreset(name, ramp) {
      if (!ready) return;
      var ps = PRESETS[name] || PRESETS['indoor-hall'];
      var t = ctx.currentTime;
      var r = ramp == null ? 0.8 : ramp;
      function to(p, v) { try { p.setTargetAtTime(v, t, r / 3); } catch (e) { p.value = v; } }
      to(waterGain.gain, ps.water);
      to(waterFilter.frequency, ps.waterHz);
      to(waterFilter.Q, ps.waterQ);
      to(lfo.frequency, ps.waveRate);
      to(lfoGain.gain, ps.waterHz * ps.waveDepth * 0.5);
      to(humGain.gain, ps.hum);
      to(humOsc2 ? humOsc2.frequency : humGain.gain, ps.humHz * 2);
      to(rumbleGain.gain, ps.rumble);
      to(wetGain.gain, ps.wet);
      ensureIR(name);
      curName = name;
    }

    /* 远处滴水：一次一响，随机间隔 */
    function scheduleDrip() {
      if (!ready || muted) { dripTimer = root.setTimeout(scheduleDrip, 2000); return; }
      var ps = PRESETS[curName] || PRESETS['indoor-hall'];
      var rate = Math.max(1, ps.dripRate);
      var gap = (60000 / rate) * (0.4 + Math.random() * 1.6);
      try {
        var t0 = ctx.currentTime + 0.05;
        var o = ctx.createOscillator();
        o.type = 'sine';
        var f0 = 700 + Math.random() * 900;
        o.frequency.setValueAtTime(f0, t0);
        o.frequency.exponentialRampToValueAtTime(f0 * 0.35, t0 + 0.13);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.055 + Math.random() * 0.05, t0 + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        o.connect(g);
        g.connect(master);
        if (wetGain && wetGain.__src) g.connect(wetGain.__src);
        o.start(t0);
        o.stop(t0 + 0.3);
      } catch (e) { /* 忽略 */ }
      dripTimer = root.setTimeout(scheduleDrip, gap);
    }

    function unlock() {
      if (!init()) return false;
      unlocked = true;
      try {
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      } catch (e) { /* 忽略 */ }
      if (!dripTimer) dripTimer = root.setTimeout(scheduleDrip, 1500);
      /* 淡入，别一上来就吓人 */
      try { master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.6); } catch (e) {}
      return true;
    }

    function setMuted(m) {
      muted = !!m;
      if (!ready) return;
      try { master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, muted ? 0.2 : 0.8); } catch (e) {}
    }

    function setVolume(v) {
      if (!ready || muted) return;
      try { master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)) * 0.9, ctx.currentTime, 0.2); } catch (e) {}
    }

    function dispose() {
      if (dripTimer) root.clearTimeout(dripTimer);
      dripTimer = null;
      try { if (ctx && ctx.close) ctx.close(); } catch (e) {}
      ready = false; ctx = null;
    }

    return {
      unlock: unlock,
      setScene: function (name) { applyPreset(name && PRESETS[name] ? name : 'indoor-hall'); },
      setMuted: setMuted,
      setVolume: setVolume,
      dispose: dispose,
      current: function () { return curName; },
      state: function () {
        return {
          supported: !failed,
          ready: ready,
          unlocked: unlocked,
          muted: muted,
          ctxState: ctx ? ctx.state : 'none',
          preset: curName,
          label: (PRESETS[curName] || {}).label || ''
        };
      }
    };
  };

  POOLCORE.soundPresets = PRESETS;
  POOLCORE.soundPresetNames = ORDER;

})(window);
