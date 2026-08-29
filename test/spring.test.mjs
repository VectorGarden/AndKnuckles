/* Obj_TitleBanner_Main's damped spring, against the ROM's own numbers.

   The banner is not an eased tween: position lives in a 32-bit fixed-point
   accumulator, acceleration flips sign across rest, and velocity is halved by an
   `asr` on every zero crossing. Ported with 68k semantics -- big-endian high-word
   reads, 16-bit wrapping adds -- and the validation is that it lands exactly on
   the ROM's own termination test, offset 0 with y_vel == -$5B, on frame 99.

   Any error in the fixed point or the damping misses that and runs to the guard,
   so `settled` doubles as the correctness check. The bounce table below is what
   the README documents; if these change, the README is wrong too. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fromSource} from './from-source.mjs';

const NEEDS = ['ROM', 'SETTLE_VEL', 'MAX_FRAMES', 'SETTLE_WIN', 's16', 's32', 'springCurve'];
const {springCurve, ROM, MAX_FRAMES} = fromSource(NEEDS);

test('stock parameters reproduce the ROM curve', async t => {
  const c = springCurve();

  await t.test('terminates on the ROM\'s own settle test', () => {
    assert.equal(c.settled, true, 'ran to the guard instead of settling');
    assert.equal(c.length, 100, 'the ROM settles on frame 99');
    assert.ok(c.length < MAX_FRAMES, 'hit the frame guard');
  });

  await t.test('rises from below rest, off screen', () => {
    // The accumulator inits to -96.0 ($FFA00000), but the first frame recorded is
    // -92: a frame adds velocity before it reads the offset, so one step of the
    // initial 4.0 px/frame is already spent. Both numbers are in the README and
    // they describe different things.
    assert.equal(c[0], -(ROM.dist - ROM.vel0));
    assert.equal(c[0], -92);
  });

  await t.test('overshoots and bounces, halving each time', () => {
    const peak = c.indexOf(Math.max(...c));
    const after = c.slice(peak), troughV = Math.min(...after), trough = peak + after.indexOf(troughV);
    const tail = c.slice(trough), p2V = Math.max(...tail), p2 = trough + tail.indexOf(p2V);
    assert.deepEqual(
      {overshoot: [peak, c[peak]], bounce2: [trough, troughV], bounce3: [p2, p2V]},
      {overshoot: [32, 38],        bounce2: [59, -13],         bounce3: [74, 4]});
  });

  await t.test('comes to rest at 0', () => {
    assert.equal(c[c.length - 1], 0);
  });

  await t.test('never leaves the excursion the headroom is sized for', () => {
    assert.equal(Math.max(...c), 38, 'canvas headroom is computed from this peak');
    assert.equal(Math.min(...c), -92);
  });
});

test('amplitude scales the whole excursion without changing its shape', () => {
  const full = springCurve(), half = springCurve({amp: 0.5});
  assert.equal(half.length, full.length);
  for(let i = 0; i < full.length; i++)
    assert.equal(half[i], Math.round(full[i] * 0.5), `frame ${i}`);
});

test('tuned parameters still terminate, or say that they will not', async t => {
  await t.test('a heavier spring settles', () => {
    const c = springCurve({damp: 0.4});
    assert.equal(c.settled, true);
    assert.equal(c[c.length - 1], 0, 'tuned curves are closed out on rest');
    assert.ok(c.length <= MAX_FRAMES);
  });

  await t.test('damping that never dissipates is reported, not hidden', () => {
    const c = springCurve({damp: 1});
    assert.equal(c.settled, false, 'should report that the loop will jump');
    assert.equal(c.length, MAX_FRAMES, 'and stop at the guard rather than hang');
  });

  await t.test('the near-1 damping that dithers 0/-1 forever still ends', () => {
    // a plain zero-run test does not terminate here; the envelope check does
    const c = springCurve({damp: 0.7});
    assert.equal(c.settled, true);
    assert.ok(c.length < MAX_FRAMES, `ran ${c.length} frames`);
  });
});
