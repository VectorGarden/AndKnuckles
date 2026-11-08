/* The scene music, in the page: when it is offered, how long playback runs with
   it, that the frame shown follows the music's clock, and that a video recorded
   with it carries the sound. What the chips produce is tested in plain Node
   (test/sound.test.mjs); this is the plumbing around them. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {open, setup} from './harness.mjs';

let browser, page;
test.before(async () => ({browser, page} = await open()));
test.after(async () => { await browser?.close(); });

const music = on => page.click(`#music button[data-music="${on ? 'on' : 'off'}"]`);
const shown = () => page.evaluate(() => getComputedStyle(document.getElementById('musicCtl')).display !== 'none');

test('the music control is offered for a scene with music, when animated', async () => {
  await setup(page, {mode: 'anim', scene: 'sk', intro: 'on'});
  assert.equal(await shown(), true, 'S&K title, animated');
  await setup(page, {mode: 'still', scene: 'sk'});
  assert.equal(await shown(), false, 'a still has no music');
  await setup(page, {mode: 'anim', scene: 'off'});
  assert.equal(await shown(), false, 'no scene, no music');
  await setup(page, {mode: 'anim', scene: 's3', intro: 'on'});
  assert.equal(await shown(), true, 'S3 title, animated');
  await setup(page, {mode: 'anim', scene: 'aiz', intro: 'on'});
  assert.equal(await shown(), true, 'the AIZ intro');
  await setup(page, {mode: 'anim', scene: 's1', intro: 'on'});
  assert.equal(await shown(), true, 'the Sonic 1 title');
  await setup(page, {mode: 'anim', scene: 's2', intro: 'on'});
  assert.equal(await shown(), false, 'a scene without music yet');
});

test('S3\'s song starts after the SEGA logo and its fade, silent until then', async () => {
  await setup(page, {mode: 'anim', scene: 's3', intro: 'on'});
  const r = await page.evaluate(async () => {
    const start = musicStart(), log = await musicLog(MUSIC, 's3', state.timebase);
    const r = renderMusic(MUSIC, 's3', start + 60, state.timebase, tbFps(), start, log);
    const per = r.rate / tbFps(), peak = (a, b) => { let m = 0; for(let i = Math.round(a*per); i < Math.round(b*per); i++) m = Math.max(m, Math.abs(r.left[i])); return m; };
    return {start, hold: sceneIntro().hold, before: peak(0, start), after: peak(start, start + 60)};
  });
  // Play_Music comes once Pal_Title has faded the backdrop to black: 8 frames
  assert.equal(r.start, r.hold + 8);
  assert.equal(r.before, 0, 'nothing before the song loads');
  assert.ok(r.after > 0.2, `the song plays from there (peak ${r.after})`);
  await setup(page, {mode: 'anim', scene: 's3', intro: 'off'});
  assert.equal(await page.evaluate(() => musicStart()), 0, 'with no opening the song starts with the scene');
});

test('with the music on, playback runs to the end of the song; GIF keeps to the animation', async () => {
  await setup(page, {mode: 'anim', scene: 'sk', intro: 'on'});
  await music(true);
  const on = await page.evaluate(() => ({play: playLen(), timeline: timelineLen(), song: musicFrames(),
                                         gif: gifFrames().offs.length, scrub: +el('scrub').max + 1}));
  assert.ok(on.song > on.timeline, 'the song outlasts the S&K loop');
  assert.equal(on.play, on.song);
  assert.equal(on.scrub, on.play, 'the scrubber covers the whole song');
  assert.equal(on.gif, on.timeline, 'GIF has no sound, so it keeps the timeline');
  await music(false);
  const off = await page.evaluate(() => ({play: playLen(), timeline: timelineLen()}));
  assert.equal(off.play, off.timeline);
});

test('zone music plays over the AIZ timeline as it is, and restarts with it', async () => {
  await setup(page, {mode: 'anim', scene: 'aiz', intro: 'on'});
  await music(true);
  const r = await page.evaluate(() => ({play: playLen(), timeline: timelineLen(), start: musicStart()}));
  assert.equal(r.play, r.timeline, 'a song that never ends does not lengthen the loop');
  assert.equal(r.start, 0);
});

test('playing starts the music, and the frame shown is the one it has reached', async () => {
  await setup(page, {mode: 'anim', scene: 'sk', intro: 'on'});
  await music(true);
  await page.click('#play');
  await page.waitForFunction(() => !!sound.src, null, {timeout: 15000});
  await page.waitForTimeout(800);
  // a tick shows the frame the music has reached -- checked straight after
  // one, so a busy machine's late animation frames cannot get in between
  const r = await page.evaluate(() => {
    tick(performance.now());
    const due = (sound.f0 + Math.floor((sound.ctx.currentTime - sound.t0) * tbFps())) % playLen();
    return {frame: player.frame, due, len: sound.src.buffer.duration, want: playLen() / tbFps(), loop: sound.src.loop};
  });
  assert.ok(Math.abs(r.frame - r.due) <= 1, `showing frame ${r.frame}, the music is at ${r.due}`);
  assert.ok(r.frame > 10, 'playback has moved on');
  assert.ok(Math.abs(r.len - r.want) < 0.001, `${r.len}s of music for a ${r.want}s timeline`);
  assert.equal(r.loop, true, 'it loops with the timeline');

  await music(false);
  assert.equal(await page.evaluate(() => sound.src), null, 'turning it off mid-play stops it');
  assert.equal(await page.evaluate(() => player.playing), true, 'and the animation plays on');
  await music(true);
  await page.waitForFunction(() => !!sound.src, null, {timeout: 15000});
  await page.click('#play');
  assert.equal(await page.evaluate(() => sound.src), null, 'pausing stops it');
});

test('switching timebase while playing restarts the music at the new rate', async () => {
  await setup(page, {mode: 'anim', scene: 'sk', intro: 'on'});
  await music(true);
  await page.click('#play');
  await page.waitForFunction(() => !!sound.src, null, {timeout: 15000});
  const pal = await page.evaluate(() => sound.src.buffer.sampleRate);
  await page.click('#timebase button[data-tb="ntsc"]');
  await page.waitForFunction(r => sound.src && sound.src.buffer.sampleRate !== r, pal, {timeout: 15000});
  const ntsc = await page.evaluate(() => ({rate: sound.src.buffer.sampleRate, len: sound.src.buffer.duration, want: playLen() / 59.92}));
  // the chips run at the console's clock either way; a frame is a frame of samples
  assert.ok(Math.abs(pal - 53098.2) < 1 && Math.abs(ntsc.rate - 53264.6) < 1, `${pal}, ${ntsc.rate}`);
  assert.ok(Math.abs(ntsc.len - ntsc.want) < 0.001);
  await page.click('#play');
  await page.click('#timebase button[data-tb="pal"]');
});

test('a WebM recorded with the music has an Opus track as long as the picture', async t => {
  await setup(page, {mode: 'anim', scene: 'sk', intro: 'on', text: 'ABC'});
  await music(true);
  const mime = await page.evaluate(() => videoMime('webm', true));
  if(!mime){ t.skip('no WebM with Opus in this browser'); return; }
  const [download] = await Promise.all([
    page.waitForEvent('download', {timeout: 120000}),
    page.click('#dlWebm'),
  ]);
  const buf = fs.readFileSync(await download.path());
  assert.ok(buf.includes(Buffer.from('A_OPUS')), 'no Opus track in the file');
  const meta = await page.evaluate(async b64 => {
    const bin = atob(b64), a = new Uint8Array(bin.length);
    for(let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    const v = document.createElement('video');
    v.muted = true; v.src = URL.createObjectURL(new Blob([a], {type: 'video/webm'}));
    await new Promise(res => { v.onloadedmetadata = res; v.onerror = res; });
    // MediaRecorder's WebM has no duration in its header; seeking far finds it
    if(v.duration === Infinity){ v.currentTime = 1e6; await new Promise(res => v.ondurationchange = res); }
    return {duration: v.duration, want: playLen() / tbFps(), status: el('status') ? el('status').textContent : ''};
  }, buf.toString('base64'));
  assert.ok(Math.abs(meta.duration - meta.want) < 0.5, `${meta.duration}s of video for ${meta.want}s of song`);
});
