/* The sound chips in src/sound.js, against what the hardware is documented to
   do, and the S&K title song played through them.

   Each chip is driven the way the Z80 drives it, by register writes, and what
   comes out is measured: a tone's pitch from its zero crossings, a level from
   its peaks. The numbers on the right of each assertion come from the chips'
   own clocks, not from the code under test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fromSource} from './from-source.mjs';

const SOUND = ['MASTER', 'LINES', 'YM_TICK', 'Z80_TICK', 'PSG_TICK', 'PSG_AMP', 'MUSIC_GAIN',
  'ymTables', 'makeYM2612', 'makePSG', 'makeDAC', 'b64bytes', 'updatesOn', 'musicRenderer', 'renderMusic'];
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

test('PAL catches up once every five frames in S&K, every six in Sonic 3', () => {
  const count = (period, n) => { let u = 0; for(let k = 0; k < n; k++) u += S.updatesOn(k, 'pal', period); return u; };
  assert.equal(count(5, 500), 599);    // 60 updates a second: on tempo
  assert.equal(count(6, 500), 583);    // frames 5, 11, ... 497: the counter reset to 6 runs PAL Sonic 3 slow
  for(let k = 0; k < 50; k++) assert.equal(S.updatesOn(k, 'ntsc', 5), 1);
});

for(const scene of ['sk', 's3']) test(`the ${scene} title song plays, in time, at both timebases`, () => {
  const song = MUSIC.songs[scene], period = MUSIC.drivers[song.driver].palPeriod;
  for(const [tb, fps] of [['ntsc', 59.92], ['pal', 50]]){
    const frames = 1300;
    const r = S.renderMusic(MUSIC, scene, frames, tb, fps, 0);
    assert.ok(Math.abs(r.left.length / r.rate - frames / fps) < 1 / r.rate + 1e-9, `${tb}: length`);
    let peak = 0, nan = false;
    for(const ch of [r.left, r.right]) for(const v of ch){ if(v !== v) nan = true; peak = Math.max(peak, Math.abs(v)); }
    assert.ok(!nan, `${tb}: NaN in the output`);
    assert.ok(peak < 1, `${tb}: clips (peak ${peak})`);
    assert.ok(peak > 0.25, `${tb}: suspiciously quiet (peak ${peak})`);
    // Both songs keep every track going to about update 860; after that a
    // last bass note and PSG lines stepping their volume down run the driver on
    // to its end, with next to nothing left to hear.
    const at = i => Math.round(i * r.rate / fps);
    const loud = (a, b) => { let m = 0; for(let i = at(a); i < at(b); i++) m = Math.max(m, Math.abs(r.left[i])); return m; };
    const frame = u => { let f = 0; for(let n = 0; n < u; f++) n += S.updatesOn(f, tb, period); return f; };
    for(let u = 0; u < 840; u += 60) assert.ok(loud(frame(u), frame(u + 60)) > 0.2, `${tb}: quiet around update ${u}`);
    assert.ok(loud(frame(song.ticks) + 30, frame(song.ticks) + 60) < 0.005, `${tb}: still sounding after the song`);
  }
});

test('AIZ1 plays the whole way across the intro, at both timebases', () => {
  // zone music: no end, so it has to sound all the way along -- and the log has
  // to last longer than the scene at either rate
  assert.equal(MUSIC.songs.aiz.loops, true);
  for(const [tb, fps, frames] of [['ntsc', 59.92, 1400], ['pal', 50, 1400]]){
    const r = S.renderMusic(MUSIC, 'aiz', frames, tb, fps, 0);
    const per = r.rate / fps;
    let peak = 0;
    for(let f = 0; f + 60 <= frames; f += 60){
      let m = 0;
      for(let i = Math.round(f * per); i < Math.round((f + 60) * per); i++){
        const v = Math.abs(r.left[i]);
        assert.ok(v === v, `${tb}: NaN at sample ${i}`);
        m = Math.max(m, v);
      }
      assert.ok(m > 0.15, `${tb}: quiet in the second from frame ${f}`);
      peak = Math.max(peak, m);
    }
    assert.ok(peak < 1, `${tb}: clips`);
  }
});
