/* The sound chips in src/sound.js, against what the hardware is documented to
   do, and the scenes' music played through them.

   Each chip is driven the way the Z80 drives it, by register writes, and what
   comes out is measured: a tone's pitch from its zero crossings, a level from
   its peaks. The numbers on the right of each assertion come from the chips'
   own clocks, not from the code under test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {fromSource} from './from-source.mjs';

const SOUND = ['MASTER', 'LINES', 'YM_TICK', 'Z80_TICK', 'PSG_TICK', 'PSG_AMP', 'MUSIC_GAIN',
  'ymTables', 'makeYM2612', 'makePSG', 'DAC_LOOPS', 'makeDAC', 'b64bytes', 'musicRenderer', 'renderMusic'];
const S = fromSource(SOUND, 'sound.js');
const {MUSIC} = fromSource(['MUSIC'], 'generated/assets.js');

const YM_RATE = S.MASTER.ntsc / S.YM_TICK;          // 53267 Hz

// zero crossings of x (less its mean) per second, halved
function pitch(x, rate){
  let mean = 0; for(const v of x) mean += v; mean /= x.length;
  let n = 0;
  for(let i = 1; i < x.length; i++) if((x[i-1] - mean) < 0 && (x[i] - mean) >= 0) n++;
  return n * rate / x.length;
}

/* channel 1 as a single sine: algorithm 7, every operator silent but S4 */
function sine(ym, fnum, block, extra = {}){
  ym.write(0, 0xB0, 7);
  for(const r of [0x40, 0x44, 0x48]) ym.write(0, r, 0x7F);
  ym.write(0, 0x4C, extra.tl ?? 0);
  ym.write(0, 0x3C, 0x01);                   // DT 0, MUL 1
  ym.write(0, 0x5C, 0x1F);                   // AR 31
  ym.write(0, 0x6C, 0); ym.write(0, 0x7C, 0);
  ym.write(0, 0x8C, extra.rr ?? 0x0F);       // SL 0, RR 15
  ym.write(0, 0xA4, block << 3 | fnum >> 8);
  ym.write(0, 0xA0, fnum & 0xFF);
  ym.write(0, 0x28, 0x80);                   // key on S4 of channel 1
}
const run = (ym, n) => { const L = new Float64Array(n); for(let i = 0; i < n; i++) L[i] = ym.sample()[0]; return L; };

test('the YM2612 sine sits where fnum and block put it', () => {
  // f = fnum * 2^(block-1) * rate / 2^20
  for(const [fnum, block] of [[1083, 4], [0x284, 2], [0x4C0, 5]]){
    const ym = S.makeYM2612();
    sine(ym, fnum, block);
    const got = pitch(run(ym, 53267), YM_RATE);
    const want = fnum * 2 ** (block - 1) * YM_RATE / 2 ** 20;
    assert.ok(Math.abs(got - want) < 1.5, `fnum ${fnum} block ${block}: ${got.toFixed(1)} Hz, want ${want.toFixed(1)}`);
  }
});

test('a full-volume operator swings the 9-bit DAC end to end', () => {
  const ym = S.makeYM2612();
  sine(ym, 1083, 4);
  const L = run(ym, 4000);
  // five idle channels sit at +4 each (the ladder, panned centre and silent)
  const idle = 5 * 4, max = Math.max(...L) - idle, min = Math.min(...L) - idle;
  assert.ok(max >= 255 + 4 - 1 && max <= 255 + 4, `peak ${max}`);
  assert.ok(min <= -256 - 3 + 1 && min >= -256 - 3, `trough ${min}`);
});

test('total level attenuates 0.75dB a step', () => {
  const peak = tl => { const ym = S.makeYM2612(); sine(ym, 1083, 4, {tl}); return Math.max(...run(ym, 4000)) - 20 - 4; };
  const ratio = peak(16) / peak(0);
  assert.ok(Math.abs(20 * Math.log10(ratio) + 12) < 0.3, `16 steps of TL gave ${(20*Math.log10(ratio)).toFixed(2)} dB`);
});

test('key off releases at the release rate', () => {
  const ym = S.makeYM2612();
  sine(ym, 1083, 4, {rr: 0x0F});
  run(ym, 2000);
  ym.write(0, 0x28, 0x00);
  // RR 15 is rate 62: the attenuation climbs 8 steps a sample-tick, gone within a few ms
  const after = run(ym, 400);
  const tail = after.slice(300).map(v => Math.abs(v - 24));
  assert.ok(Math.max(...tail) < 2, `still sounding: ${Math.max(...tail)}`);
});

test('the PSG tone is the Z80 clock over 32 times the period', () => {
  const psg = S.makePSG();
  psg.write(0x80 | 254 & 15); psg.write(254 >> 4);   // channel 0, period 254
  psg.write(0x90);                                   // volume 0 (loudest)
  const rate = S.MASTER.ntsc / S.PSG_TICK, n = Math.round(rate);
  const x = new Float64Array(n);
  for(let i = 0; i < n; i++){ psg.step(); x[i] = psg.level(); }
  const want = S.MASTER.ntsc / 15 / (32 * 254);
  assert.ok(Math.abs(pitch(x, rate) - want) < 1, `${pitch(x, rate)} Hz, want ${want}`);
});

test('the PSG attenuates 2dB a step', () => {
  const amp = v => { const p = S.makePSG(); p.write(0x80 | 0x0C); p.write(0x10); p.write(0x90 | v);
    let m = 0; for(let i = 0; i < 5000; i++){ p.step(); m = Math.max(m, p.level()); } return m; };
  const db = 20 * Math.log10(amp(5) / amp(0));
  assert.ok(Math.abs(db + 10) < 0.01, `5 steps gave ${db.toFixed(2)} dB`);
  assert.equal(amp(15), 0, 'attenuation 15 is off');
});

test("the DAC loop delivers a sample at its DAC_Setup rate", () => {
  const drv = MUSIC.drivers.s3k, writes = [];
  const ym = {write: (part, reg, val) => writes.push([t, reg, val])};
  let t = 0;
  const dac = S.makeDAC(drv, ym);
  dac.queue(0x06, 0);                               // 86h, the S3 kick
  for(t = 0; t < S.MASTER.ntsc / 10; t += S.YM_TICK) dac.run(t);
  const data = writes.filter(w => w[1] === 0x2A);
  assert.ok(writes[0][1] === 0x2B && writes[0][2] === 0x80, 'the DAC is enabled first');
  // 303 cycles a byte plus 26 per djnz turn past the first, two nibbles a byte
  const loop = drv.dac['86'].loop;
  const want = 2 * S.MASTER.ntsc / 15 / (303 + 26 * (loop - 1));
  const span = data[data.length - 1][0] - data[0][0];
  const got = (data.length - 1) / (span / S.MASTER.ntsc);
  assert.ok(Math.abs(got - want) / want < 0.02, `${got.toFixed(0)} Hz, want ${want.toFixed(0)} (DAC_Setup says ${drv.dac['86'].rate})`);
  // and every nibble of it, then the DAC off again
  assert.equal(data.length, b64len(drv.dac['86'].data) * 2);
  assert.deepEqual(writes[writes.length - 1].slice(1), [0x2B, 0]);
});
const b64len = s => S.b64bytes(s).length;

// a scene's log for a timebase, inflated as the page's musicLog does
const log = (scene, tb) => new Uint8Array(inflateSync(Buffer.from(MUSIC.songs[scene].logs[tb], 'base64')));
const render = (scene, frames, tb, fps) => S.renderMusic(MUSIC, scene, frames, tb, fps, 0, log(scene, tb));
// the loudest sample of channel L between two frames
const loudness = (r, fps) => (a, b) => {
  let m = 0;
  for(let i = Math.round(a * r.rate / fps); i < Math.round(b * r.rate / fps); i++){
    const v = Math.abs(r.left[i]);
    assert.ok(v === v, `NaN at sample ${i}`);
    m = Math.max(m, v);
  }
  return m;
};

for(const scene of ['sk', 's3']) test(`the ${scene} title song plays, in time, at both timebases`, () => {
  const song = MUSIC.songs[scene];
  for(const [tb, fps] of [['ntsc', 59.92], ['pal', 50]]){
    const frames = 1300;
    const r = render(scene, frames, tb, fps);
    assert.ok(Math.abs(r.left.length / r.rate - frames / fps) < 1 / r.rate + 1e-9, `${tb}: length`);
    let peak = 0;
    for(const ch of [r.left, r.right]) for(const v of ch) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak < 1, `${tb}: clips (peak ${peak})`);
    assert.ok(peak > 0.25, `${tb}: suspiciously quiet (peak ${peak})`);
    // Both songs keep every track going to about update 860 -- frame 860 on
    // NTSC, a sixth or so fewer on PAL; after that a last bass note and PSG lines
    // stepping their volume down run the driver on to its end, with next to
    // nothing left to hear.
    const loud = loudness(r, fps), end = Math.round(860 * song.frames[tb] / song.frames.ntsc) - 20;
    for(let f = 0; f + 60 <= end; f += 60) assert.ok(loud(f, f + 60) > 0.2, `${tb}: quiet in the second from frame ${f}`);
    assert.ok(loud(song.frames[tb] + 30, song.frames[tb] + 60) < 0.005, `${tb}: still sounding after the song`);
  }
});

/* The AIZ intro's own soundtrack: AIZ1 until Knuckles' cutscene starts, a fade
   while Obj_Song_Fade_Transition counts down, then Knuckles' theme, and a fade
   again as he runs off. */
test('the AIZ intro plays AIZ1, fades for Knuckles, then plays his theme', () => {
  const song = MUSIC.songs.aiz;
  assert.equal(song.loops, true);
  for(const [tb, fps] of [['ntsc', 59.92], ['pal', 50]]){
    const r = render('aiz', 1300, tb, fps), loud = loudness(r, fps);
    for(let f = 0; f + 60 <= 587; f += 60) assert.ok(loud(f, f + 60) > 0.15, `${tb}: AIZ1 quiet in the second from frame ${f}`);
    // the fade halts the drums and PSG at once and lowers the FM a step every
    // 6 V-ints: by the time Knuckles' theme comes it is well down
    assert.ok(loud(660, 678) < loud(520, 586) / 2, `${tb}: no fade before Knuckles' theme`);
    for(let f = 690; f + 60 <= 1083; f += 60) assert.ok(loud(f, f + 60) > 0.15, `${tb}: Knuckles' theme quiet in the second from frame ${f}`);
    assert.ok(loud(1180, 1200) < loud(1020, 1080) / 2, `${tb}: no fade as Knuckles runs off`);
  }
});

/* Sonic 1's Z80 program plays its samples through zPlayPCMLoop: 301 cycles a
   byte plus 26 a djnz turn, and it never disables the DAC afterwards. */
test("Sonic 1's DAC loop plays the kick at its WAV's rate and leaves the DAC on", () => {
  const drv = MUSIC.drivers.s1, writes = [];
  let t = 0;
  const ym = {write: (part, reg, val) => writes.push([t, reg, val])};
  const dac = S.makeDAC(drv, ym);
  dac.queue(0x01, 0);                                // 81h, the kick
  for(t = 0; t < S.MASTER.ntsc / 10; t += S.YM_TICK) dac.run(t);
  const data = writes.filter(w => w[1] === 0x2A);
  const want = 2 * S.MASTER.ntsc / 15 / (301 + 26 * (drv.dac['81'].loop - 1));
  const got = (data.length - 1) / ((data[data.length - 1][0] - data[0][0]) / S.MASTER.ntsc);
  assert.ok(Math.abs(got - want) / want < 0.02, `${got.toFixed(0)} Hz, want ${want.toFixed(0)}`);
  assert.ok(Math.abs(want - drv.dac['81'].rate) / drv.dac['81'].rate < 0.02, 'and that is about the WAV rate');
  assert.equal(writes.filter(w => w[1] === 0x2B && w[2] === 0).length, 0, 'the DAC is never disabled');
});

test("the timpani plays at the pitch the 68K set for it", () => {
  // the 68K's DAC_sample_rate write lands in the timpani's own table entry
  const rate = pitch => {
    const writes = []; let t = 0;
    const dac = S.makeDAC({...MUSIC.drivers.s1, dac: {'83': MUSIC.drivers.s1.dac['82']}},
                          {write: (p, reg) => reg === 0x2A && writes.push(t)});
    dac.setPitch(pitch); dac.queue(0x03, 0);
    for(t = 0; t < S.MASTER.ntsc / 20; t += S.YM_TICK) dac.run(t);
    return writes.length;
  };
  assert.ok(rate(10) > rate(30), 'a smaller djnz count plays faster');
});

test("Sonic 1's title song plays and ends, at both timebases", () => {
  const song = MUSIC.songs.s1;
  // no PAL catch-up in Sonic 1: the same frames, so a sixth slower in seconds
  assert.equal(song.frames.pal, song.frames.ntsc);
  for(const [tb, fps] of [['ntsc', 59.92], ['pal', 50]]){
    const r = render('s1', 700, tb, fps), loud = loudness(r, fps);
    // the drums lead in from frame 16; every track plays to about frame 420
    for(let f = 16; f + 60 <= 420; f += 60) assert.ok(loud(f, f + 60) > 0.2, `${tb}: quiet in the second from frame ${f}`);
    assert.ok(loud(0, 15) < 0.005, `${tb}: something before the first snare`);
    assert.ok(loud(song.frames[tb] + 30, song.frames[tb] + 60) < 0.005, `${tb}: still sounding after the song`);
  }
});

test('Green Hill Zone plays the whole way across the scene', () => {
  assert.equal(MUSIC.songs.ghz.loops, true);
  for(const [tb, fps] of [['ntsc', 59.92], ['pal', 50]]){
    const r = render('ghz', 1300, tb, fps), loud = loudness(r, fps);
    for(let f = 0; f + 60 <= 1300; f += 60) assert.ok(loud(f, f + 60) > 0.2, `${tb}: quiet in the second from frame ${f}`);
  }
});
