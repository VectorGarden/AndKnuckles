/* ---------- sound: a YM2612 and a PSG for the music logs -----------------
   The pipeline runs each game's own sound driver offline (tools/go/sound) and
   keeps what it wrote to the chips on every V-int. This plays that log: a
   YM2612 and an SN76489 at the console's own clocks, and the Z80's DAC loop
   feeding sample nibbles to the YM's DAC at the cycle counts its code takes.

   The YM2612 is modelled a sample at a time, the way ymfm does it (Aaron
   Giles's BSD-licensed OPN core): the log-sine and power tables are the ones
   read off the die, the envelope generator steps every third sample through the
   chip's increment patterns, and each channel's 14-bit output goes through the
   9-bit DAC with the discrete chip's "ladder" offset either side of zero.
   Timers, the test register and SSG-EG are not modelled; no song here uses
   them. */

// clocks, in master cycles: the YM2612 makes a sample every 7*144 of them, the
// Z80 runs at 1/15, the PSG counts at 1/(15*16), and a frame is lines * 3420
const MASTER = {ntsc: 53693175, pal: 53203424};
const LINES = {ntsc: 262, pal: 313};
const YM_TICK = 7*144, Z80_TICK = 15, PSG_TICK = 15*16;
// a PSG channel at full volume against a YM channel's 9-bit swing, as Genesis
// Plus GX mixes them by default; and the overall level, one for every song so
// they keep their loudness relative to each other (the loudest, S3's title,
// peaks around 770 of these units)
const PSG_AMP = 64, MUSIC_GAIN = 1/1024;

function ymTables(){
  const sin = new Uint16Array(256), pow = new Uint16Array(256);
  for(let i = 0; i < 256; i++){
    sin[i] = Math.round(-Math.log2(Math.sin((i + 0.5) * Math.PI / 512)) * 256);
    pow[i] = Math.round((Math.pow(2, (255 - i) / 256) - 1) * 1024);
  }
  // the detune for each keycode at detune 0-3 (4-7 negate it)
  const dt = [[0,0,1,2],[0,0,1,2],[0,0,1,2],[0,0,1,2],[0,1,2,2],[0,1,2,3],[0,1,2,3],[0,1,2,3],
    [0,1,2,4],[0,1,3,4],[0,1,3,4],[0,1,3,5],[0,2,4,5],[0,2,4,6],[0,2,4,6],[0,2,5,7],
    [0,2,5,8],[0,3,6,8],[0,3,6,9],[0,3,7,10],[0,4,8,11],[0,4,8,12],[0,4,9,13],[0,5,10,14],
    [0,5,11,16],[0,6,12,17],[0,6,13,19],[0,7,14,20],[0,8,16,22],[0,8,16,22],[0,8,16,22],[0,8,16,22]];
  // envelope increments per rate, eight steps a nibble each, low nibble first;
  // rates 4-7 are the YM2612's own odd pairs
  const inc = new Uint32Array(64);
  const row = [0x10101010, 0x10111010, 0x11101110, 0x11111110];
  for(let r = 8; r < 48; r++) inc[r] = row[r & 3];
  inc.set([0, 0, 0x10101010, 0x10101010, 0x10101010, 0x10101010, 0x11101110, 0x11101110], 0);
  inc.set([0x11111111, 0x21112111, 0x21212121, 0x22212221, 0x22222222, 0x42224222, 0x42424242, 0x44424442,
           0x44444444, 0x84448444, 0x84848484, 0x88848884, 0x88888888, 0x88888888, 0x88888888, 0x88888888], 48);
  // LFO phase modulation: two shifts of the top 7 bits of the fnum per step
  const pm = [[0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77],[0x77,0x77,0x77,0x77,0x72,0x72,0x72,0x72],
    [0x77,0x77,0x77,0x72,0x72,0x72,0x17,0x17],[0x77,0x77,0x72,0x72,0x17,0x17,0x12,0x12],
    [0x77,0x77,0x72,0x17,0x17,0x17,0x12,0x07],[0x77,0x77,0x17,0x12,0x07,0x07,0x02,0x01],
    [0x77,0x77,0x17,0x12,0x07,0x07,0x02,0x01],[0x77,0x77,0x17,0x12,0x07,0x07,0x02,0x01]];
  return {sin, pow, dt, inc, pm};
}

/* A YM2612. write(part, reg, val) as the Z80 does; sample() advances one chip
   sample and returns [left, right] in 9-bit DAC steps, ladder included. */
function makeYM2612(){
  const T = ymTables();
  const ATTACK = 0, DECAY = 1, SUSTAIN = 2, RELEASE = 3;
  // which slot each register offset (+0, +4, +8, +C) is: S1, S3, S2, S4
  const SLOT = [0, 2, 1, 3];
  // per algorithm: op2's input, op3's, op4's (opout indices), and which of
  // op1-op3 also go to the output -- ymfm's s_algorithm_ops
  const ALG = [[1,2,3,0,0,0],[0,5,3,0,0,0],[0,2,6,0,0,0],[1,0,7,0,0,0],
               [1,0,3,0,1,0],[1,1,1,0,1,1],[1,0,0,0,1,1],[0,0,0,1,1,1]];
  const op = () => ({dt:0, mul:1, tl:0, ks:0, ar:0, am:0, d1r:0, d2r:0, sl:0, rr:0,
                     phase:0, env:0x3FF, state:RELEASE, key:false, step:0, rates:[0,0,0,0], sus:0});
  const ch = Array.from({length: 6}, () => ({ops: [op(), op(), op(), op()], fnum:0, block:0,
    fb:0, alg:0, l:true, r:true, ams:0, pms:0, fbuf:[0, 0], fin:0, dirty:true}));
  const sp = {fnum:[0,0,0], block:[0,0,0]};   // channel 3's per-operator frequencies
  let latch = 0, latchSp = 0, ch3mode = 0, lfoOn = false, lfoRate = 0, lfoCnt = 0, lfoAm = 0, lfoPm = 0;
  let egCnt = 0, egSub = 0, dacOn = false, dac = 0;

  function cache(c){
    const C = ch[c];
    for(let s = 0; s < 4; s++){
      const o = C.ops[s];
      let fnum = C.fnum, block = C.block;
      if(c === 2 && ch3mode && s < 3){ const i = [1, 2, 0][s]; fnum = sp.fnum[i]; block = sp.block[i]; }
      const bf = block << 11 | fnum;
      const kc = (bf >> 10 & 15) << 1 | (0xFE80 >> (bf >> 7 & 15) & 1);
      let f = fnum << 1;
      if(C.pms){
        const sh = T.pm[C.pms][Math.abs(lfoPm) & 7];
        let adj = ((fnum >> 4) >> (sh & 15)) + ((fnum >> 4) >> (sh >> 4));
        if(C.pms > 5) adj <<= C.pms - 5;
        adj >>= 2;
        f = (f + (lfoPm < 0 ? -adj : adj)) & 0xFFF;
      }
      let step = (f << block) >> 2;
      const d = T.dt[kc][o.dt & 3];
      step = (step + (o.dt & 4 ? -d : d)) & 0x1FFFF;
      o.step = (step * (o.mul ? o.mul * 2 : 1)) >> 1;
      const ksr = kc >> (o.ks ^ 3), eff = r => r ? Math.min(63, r + ksr) : 0;
      o.rates[ATTACK] = eff(o.ar * 2); o.rates[DECAY] = eff(o.d1r * 2);
      o.rates[SUSTAIN] = eff(o.d2r * 2); o.rates[RELEASE] = eff(o.rr * 4 + 2);
      let sl = o.sl; sl |= (sl + 1) & 0x10; o.sus = sl << 5;
    }
    C.dirty = !!C.pms;
  }

  function keyon(o, on){
    if(on && !o.key){
      if(o.state !== ATTACK){
        o.state = ATTACK; o.phase = 0;
        if(o.rates[ATTACK] >= 62) o.env = 0;
      }
    } else if(!on && o.key && o.state !== RELEASE) o.state = RELEASE;
    o.key = on;
  }

  function write(part, reg, val){
    if(part === 0 && reg < 0x30){
      if(reg === 0x22){ lfoOn = !!(val & 8); lfoRate = val & 7; if(!lfoOn){ lfoCnt = 0; lfoAm = 0; lfoPm = 0; } ch.forEach(C => C.dirty = true); }
      else if(reg === 0x27){ ch3mode = val >> 6; ch[2].dirty = true; }
      else if(reg === 0x28){
        const n = val & 7; if((n & 3) === 3) return;
        const c = (n & 4 ? 3 : 0) + (n & 3), C = ch[c];
        if(C.dirty) cache(c);
        for(let s = 0; s < 4; s++) keyon(C.ops[s], !!(val & (0x10 << s)));
      }
      else if(reg === 0x2A) dac = val;
      else if(reg === 0x2B) dacOn = !!(val & 0x80);
      return;
    }
    const cn = reg & 3; if(cn === 3) return;
    const c = cn + part * 3, C = ch[c];
    if(reg >= 0x30 && reg < 0xA0){
      const o = C.ops[SLOT[reg >> 2 & 3]];
      switch(reg & 0xF0){
        case 0x30: o.dt = val >> 4 & 7; o.mul = val & 15; break;
        case 0x40: o.tl = val & 0x7F; break;
        case 0x50: o.ks = val >> 6; o.ar = val & 31; break;
        case 0x60: o.am = val >> 7; o.d1r = val & 31; break;
        case 0x70: o.d2r = val & 31; break;
        case 0x80: o.sl = val >> 4; o.rr = val & 15; break;
        // 0x90 SSG-EG is not modelled
      }
      C.dirty = true;
      return;
    }
    switch(reg & 0xFC){
      case 0xA4: latch = val & 0x3F; return;
      case 0xA0: C.fnum = (latch & 7) << 8 | val; C.block = latch >> 3 & 7; C.dirty = true; return;
      case 0xAC: if(part === 0) latchSp = val & 0x3F; return;
      case 0xA8: if(part === 0){ sp.fnum[cn] = (latchSp & 7) << 8 | val; sp.block[cn] = latchSp >> 3 & 7; ch[2].dirty = true; } return;
      case 0xB0: C.fb = val >> 3 & 7; C.alg = val & 7; return;
      case 0xB4: C.l = !!(val & 0x80); C.r = !!(val & 0x40); C.ams = val >> 4 & 3; C.pms = val & 7; C.dirty = true; return;
    }
  }

  // the 14-bit output of an operator whose phase input is p
  function opOut(o, p, am){
    if(o.env > 0x380) return 0;
    p &= 0x3FF;
    const s = T.sin[(p & 0x100 ? ~p : p) & 0xFF];
    let a = o.env + (o.am ? am : 0) + (o.tl << 3);
    if(a > 0x3FF) a = 0x3FF;
    const x = s + (a << 2);
    const v = x >> 8 > 12 ? 0 : ((T.pow[x & 0xFF] | 0x400) << 2) >> (x >> 8);
    return p & 0x200 ? -v : v;
  }

  function clockEnv(o, cnt){
    if(o.state === ATTACK && o.env === 0) o.state = DECAY;
    if(o.state === DECAY && o.env >= o.sus) o.state = SUSTAIN;
    const rate = o.rates[o.state], shift = rate >> 2;
    const c = (cnt & 0xFFF) << shift;
    if(c & 0x7FF) return;
    const inc = T.inc[rate] >>> (4 * (c >> (shift <= 11 ? 11 : shift) & 7)) & 15;
    if(o.state === ATTACK){
      if(rate < 62) o.env += (~o.env * inc) >> 4;
    } else {
      o.env += inc;
      if(o.env > 0x3FF) o.env = 0x3FF;
    }
  }

  const clamp = v => v > 8191 ? 8191 : v < -8192 ? -8192 : v;
  const AM_SHIFT = [7, 3, 1, 0], LFO_MAX = [109, 78, 72, 68, 63, 45, 9, 6];
  const opout = new Int32Array(8), out = [0, 0];
  function sample(){
    // the envelope runs on every third sample
    let egTick = false;
    if(++egSub === 3){ egSub = 0; egCnt = (egCnt + 1) & 0xFFF; egTick = true; }
    if(lfoOn){
      const sub = lfoCnt & 0xFF; lfoCnt++;
      if(sub >= LFO_MAX[lfoRate]) lfoCnt += 0x101 - sub;
      lfoAm = lfoCnt >> 8 & 0x3F; if(!(lfoCnt >> 14 & 1)) lfoAm ^= 0x3F;
      let p = lfoCnt >> 10 & 7; if(lfoCnt >> 13 & 1) p ^= 7;
      lfoPm = lfoCnt >> 14 & 1 ? -p : p;
    }
    let L = 0, R = 0;
    for(let c = 0; c < 6; c++){
      const C = ch[c];
      if(C.dirty) cache(c);
      C.fbuf[0] = C.fbuf[1]; C.fbuf[1] = C.fin;
      for(const o of C.ops){
        if(egTick) clockEnv(o, egCnt);
        o.phase = (o.phase + o.step) & 0xFFFFF;
      }
      const am = (lfoAm << 1) >> AM_SHIFT[C.ams];
      const o1 = C.ops[0], o2 = C.ops[1], o3 = C.ops[2], o4 = C.ops[3], A = ALG[C.alg];
      let v;
      if(c === 5 && dacOn) v = ((dac - 0x80) << 6);    // 8 bits into the 9-bit DAC: <<1, then <<5 to 14
      else {
        const mod = C.fb ? (C.fbuf[0] + C.fbuf[1]) >> (10 - C.fb) : 0;
        opout[1] = C.fin = opOut(o1, (o1.phase >> 10) + mod, am);
        opout[2] = opOut(o2, (o2.phase >> 10) + (opout[A[0]] >> 1), am);
        opout[5] = opout[1] + opout[2];
        opout[3] = opOut(o3, (o3.phase >> 10) + (opout[A[1]] >> 1), am);
        opout[6] = opout[1] + opout[3]; opout[7] = opout[2] + opout[3];
        v = opOut(o4, (o4.phase >> 10) + (opout[A[2]] >> 1), am);
        if(A[3]) v = clamp(v + opout[1]);
        if(A[4]) v = clamp(v + opout[2]);
        if(A[5]) v = clamp(v + opout[3]);
      }
      // the 9-bit DAC, and the discrete YM2612's crossover step: a channel
      // reads 4 above zero when positive, 3 below when negative, and +-4 when
      // panned off (Nuked-OPN2's model, averaged over the channel's slot)
      const d = v >> 5, on = d >= 0 ? d + 4 : d - 3, off = d >= 0 ? 4 : -4;
      L += C.l ? on : off; R += C.r ? on : off;
    }
    out[0] = L; out[1] = R;
    return out;
  }
  return {write, sample};
}

/* The SN76489 in the VDP: three squares and a noise channel, counting at the
   Z80 clock over 16. step() is one count; level() the summed output. */
function makePSG(){
  const vol = Array.from({length: 16}, (_, i) => i === 15 ? 0 : Math.pow(10, -i / 10));
  const period = [0, 0, 0], cnt = [0, 0, 0], out = [1, 1, 1], att = [15, 15, 15, 15];
  let noise = 0, lfsr = 0x8000, ncnt = 0, nout = 0, nflip = 0, latched = 0;
  function write(v){
    if(v & 0x80){
      latched = v >> 4 & 7;
      const ch = latched >> 1;
      if(latched & 1) att[ch] = v & 15;
      else if(ch < 3) period[ch] = period[ch] & 0x3F0 | v & 15;
      else { noise = v & 7; lfsr = 0x8000; }
    } else {
      const ch = latched >> 1;
      if(latched & 1) att[ch] = v & 15;
      else if(ch < 3) period[ch] = (v & 0x3F) << 4 | period[ch] & 15;
      else { noise = v & 7; lfsr = 0x8000; }
    }
  }
  function step(){
    for(let c = 0; c < 3; c++){
      if(--cnt[c] <= 0){ cnt[c] = period[c] || 1; out[c] ^= 1; if(period[c] <= 1) out[c] = 1; }
    }
    if(--ncnt <= 0){
      ncnt = (noise & 3) === 3 ? (period[2] || 1) : 0x10 << (noise & 3);
      nflip ^= 1;
      if(nflip){
        const fb = noise & 4 ? (lfsr ^ lfsr >> 3) & 1 : lfsr & 1;
        lfsr = lfsr >> 1 | fb << 15;
        nout = lfsr & 1;
      }
    }
  }
  function level(){
    let s = 0;
    for(let c = 0; c < 3; c++) s += (out[c] ? 1 : -1) * vol[att[c]];
    return s + (nout ? 1 : -1) * vol[att[3]];
  }
  return {write, step, level};
}

/* zPlayDigitalAudio, by cycle. Starting a sample costs the idle loop's ~100
   cycles to the DAC enable and ~450 to the first pass; each pass then sends a
   byte's two nibbles, the first 125 cycles in and the second 238, plus 13 per
   djnz turn each wait, and looks for a newly queued sample 29 cycles after
   the second. The V-int's own time on the Z80 is not taken out of it. */
function makeDAC(drv, ym){
  const D = drv.dac, deltas = drv.deltas;
  const cyc = c => c * Z80_TICK;
  let cur = null, queued = null, events = [];
  const bytesOf = id => D[id].bytes || (D[id].bytes = b64bytes(D[id].data));
  function start(id, t){
    const s = D[id];
    events = [[t + cyc(100), 0x2B, 0x80]];
    cur = {id, bytes: bytesOf(id), i: 0, acc: 0x80, b: s.loop, at: t + cyc(450)};
    plan();
  }
  // the next pass's two writes and its check
  function plan(){
    const k = 13 * (cur.b - 1), pass = cyc(303 + 2*k), byte = cur.bytes[cur.i];
    cur.acc = (cur.acc + deltas[byte >> 4]) & 0xFF;
    events.push([cur.at + cyc(125 + k), 0x2A, cur.acc]);
    cur.acc = (cur.acc + deltas[byte & 15]) & 0xFF;
    events.push([cur.at + cyc(238 + 2*k), 0x2A, cur.acc]);
    cur.check = cur.at + cyc(238 + 2*k + 29);
    cur.at += pass;
  }
  function queue(idx, t){ queued = {id: idx ? (0x80 + idx).toString(16).toUpperCase() : null, t}; }
  function run(t){
    for(;;){
      while(events.length && events[0][0] <= t){ const e = events.shift(); ym.write(0, e[1], e[2]); }
      if(events.length) return;
      if(!cur){
        if(queued && queued.t <= t){ const q = queued; queued = null; if(q.id && D[q.id]) start(q.id, q.t); continue; }
        return;
      }
      if(cur.check > t) return;
      if(queued && queued.t <= cur.check){
        const q = queued; queued = null;
        if(q.id && D[q.id]) start(q.id, cur.check); else cur = null;
        continue;
      }
      if(++cur.i < cur.bytes.length){ plan(); continue; }
      events.push([cur.check + cyc(60), 0x2B, 0]);      // zPlayDigitalAudio disables the DAC
      cur = null;
    }
  }
  return {queue, run};
}

function b64bytes(s){
  const bin = atob(s), b = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

/* A scene's music log for timebase tb, inflated. The pipeline deflates them
   (zlib), and they are read once. */
async function musicLog(music, scene, tb){
  const song = music.songs[scene], logs = song.bytes || (song.bytes = {});
  if(!logs[tb]){
    const s = new Blob([b64bytes(song.logs[tb])]).stream().pipeThrough(new DecompressionStream('deflate'));
    logs[tb] = new Uint8Array(await new Response(s).arrayBuffer());
  }
  return logs[tb];
}

/* A scene's music over a timeline of `frames` frames at timebase tb, rendered a
   stretch at a time: next(n) renders up to n more frames and says whether it is
   done. The samples are at the chip's own rate stretched to the page's frame
   rate (fps), so a frame of audio is exactly a frame of animation. log is the
   scene's inflated log for tb, a record a frame -- the driver ran twice on some
   PAL frames, and the scene's own fades and song changes are in it -- and the
   song loads on timeline frame `start`. */
function musicRenderer(music, scene, frames, tb, fps, start, log){
  const drv = music.drivers[music.songs[scene].driver];
  const frameM = LINES[tb] * 3420, perFrame = frameM / YM_TICK;
  const n = Math.ceil(frames * perFrame);
  const left = new Float32Array(n), right = new Float32Array(n);
  const ym = makeYM2612(), psg = makePSG(), dac = makeDAC(drv, ym);
  let p = 0, done = false, psgAcc = 0, s = 0, f = 0;
  // one frame's driver updates: every write, all at the V-int
  function update(t){
    for(;;){
      const c = log[p++];
      if(c === 0x62) return;
      if(c === 0x66 || c === undefined){ done = true; return; }
      if(c === 0x50) psg.write(log[p++]);
      else if(c === 0x52 || c === 0x53){ ym.write(c - 0x52, log[p], log[p+1]); p += 2; }
      else if(c === 0x95) dac.queue(log[p++], t);
      else throw new Error('bad music log byte ' + c);
    }
  }
  // a DC blocker, as the console's output capacitors are, settled on the idle
  // chip: six channels at +4 each, the crossover step either side of zero
  let xl = 24 * MUSIC_GAIN, yl = 0, xr = xl, yr = 0;
  function next(count){
    for(const stop = Math.min(frames, f + count); f < stop; f++){
      if(f >= start && !done) update(f * frameM);
      const end = Math.min(n, Math.ceil((f + 1) * perFrame));
      for(; s < end; s++){
        dac.run(s * YM_TICK);
        const o = ym.sample();
        // the PSG counts 4.2 times a chip sample: average what it put out
        psgAcc += YM_TICK; let m = 0, c = 0;
        while(psgAcc >= PSG_TICK){ psgAcc -= PSG_TICK; psg.step(); m += psg.level(); c++; }
        const q = c ? m / c * PSG_AMP : 0;
        const l = (o[0] + q) * MUSIC_GAIN, r = (o[1] + q) * MUSIC_GAIN;
        yl = l - xl + 0.9995 * yl; xl = l;
        yr = r - xr + 0.9995 * yr; xr = r;
        left[s] = yl; right[s] = yr;
      }
    }
    return f >= frames;
  }
  return {next, left, right, rate: perFrame * fps};
}
function renderMusic(music, scene, frames, tb, fps, start, log){
  const r = musicRenderer(music, scene, frames, tb, fps, start, log);
  while(!r.next(1e9));
  return r;
}
