/* The WebM and MP4 paths, driven through the actual buttons.

   Unlike GIF and APNG there is no byte-level round-trip to do here: the frames
   go through MediaRecorder and a lossy codec, so the pixels that come back are
   not the pixels that went in. What can be checked is everything around that --
   that the UI's enabled state matches what MediaRecorder actually supports, that
   the button produces a file, that the container is what was asked for, and that
   the result decodes with the right dimensions and a sane duration.

   Codec support varies by build, so the test is driven by videoMime() rather
   than assuming: a format the browser does not support must leave its button
   disabled, which is an invariant worth holding either way. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {open, setup} from './harness.mjs';

let browser, page;
test.before(async () => ({browser, page} = await open()));
test.after(async () => { await browser?.close(); });

const support = () => page.evaluate(() => ({
  webm: videoMime('webm'), mp4: videoMime('mp4'),
  recorder: typeof MediaRecorder !== 'undefined',
}));

test('a browser with MediaRecorder can encode at least one format', async () => {
  // Without this the codec tests below skip themselves when videoMime() returns
  // null, so breaking the VIDEO table would quietly remove coverage instead of
  // failing. Every browser that has MediaRecorder supports some WebM profile.
  await setup(page, {mode: 'anim', scene: 'off'});
  const s = await support();
  assert.equal(s.recorder, true, 'no MediaRecorder -- these tests cannot run');
  // Specifically WebM: these run in Chromium, which always has a VP8/VP9
  // encoder, so a null here means the VIDEO table is wrong rather than the
  // browser being limited. `webm || mp4` would let a broken WebM list hide
  // behind MP4 support and quietly skip the recording test below.
  assert.ok(s.webm, 'Chromium should encode some WebM profile; the VIDEO table is wrong');
});

test('a format the browser cannot encode leaves its button disabled', async () => {
  await setup(page, {mode: 'anim', scene: 'off'});
  const s = await support();
  const state = await page.evaluate(() => ({
    webm: document.getElementById('dlWebm').disabled,
    mp4:  document.getElementById('dlMp4').disabled,
  }));
  assert.equal(state.webm, !s.webm, 'WebM button state disagrees with videoMime');
  assert.equal(state.mp4,  !s.mp4,  'MP4 button state disagrees with videoMime');
});

test('both video buttons are disabled in still mode', async () => {
  await setup(page, {mode: 'still', scene: 'off'});
  const state = await page.evaluate(() => ({
    webm: document.getElementById('dlWebm').disabled,
    mp4:  document.getElementById('dlMp4').disabled,
  }));
  assert.deepEqual(state, {webm: true, mp4: true}, 'video is animated-only');
});

test('with no text, nothing is exportable', async () => {
  await setup(page, {mode: 'anim', scene: 'off', text: '   '});
  const disabled = await page.evaluate(() => ['dlGif','dlApng','dlWebm','dlMp4','dlPng']
    .every(id => document.getElementById(id).disabled));
  assert.equal(disabled, true);
});

/* container sniffing, independent of how the file was written */
const container = buf => {
  if(buf.length > 4 && buf.readUInt32BE(0) === 0x1A45DFA3) return 'webm';   // EBML
  if(buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  return `unknown (${buf.subarray(0, 8).toString('hex')})`;
};

for(const kind of ['webm', 'mp4']){
  test(`${kind}: the button produces a decodable file`, async t => {
    await setup(page, {mode: 'anim', scene: 'off'});
    const s = await support();
    if(!s[kind]){ t.skip(`this browser cannot encode ${kind}`); return; }

    const btn = kind === 'webm' ? '#dlWebm' : '#dlMp4';
    const [download] = await Promise.all([
      page.waitForEvent('download', {timeout: 120000}),
      page.click(btn),
    ]);
    const path = await download.path();
    const buf = fs.readFileSync(path);

    assert.ok(buf.length > 2000, `only ${buf.length} bytes`);
    assert.equal(container(buf), kind, 'wrong container for the requested format');
    assert.match(download.suggestedFilename(), new RegExp(`\\.${kind}$`));

    // hand it back to the browser and make sure it actually decodes
    const meta = await page.evaluate(async ({b64, mime}) => {
      const bin = atob(b64), a = new Uint8Array(bin.length);
      for(let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([a], {type: mime}));
      const v = document.createElement('video');
      v.muted = true; v.src = url;
      const ok = await new Promise(res => {
        v.onloadedmetadata = () => res(true);
        v.onerror = () => res(false);
        setTimeout(() => res(false), 15000);
      });
      const out = {ok, w: v.videoWidth, h: v.videoHeight, duration: v.duration};
      URL.revokeObjectURL(url);
      return out;
    }, {b64: buf.toString('base64'), mime: `video/${kind}`});

    assert.equal(meta.ok, true, `${kind} did not decode`);
    const size = await page.evaluate(() => {
      const L = layout(), g = geom(L), scale = scaleFor(L);
      return {w: g.w0 * scale, h: g.h0 * scale};
    });
    assert.deepEqual({w: meta.w, h: meta.h}, size, 'recorded at the wrong size');
    assert.ok(meta.duration > 0.2, `duration ${meta.duration}s looks empty`);
  });
}
