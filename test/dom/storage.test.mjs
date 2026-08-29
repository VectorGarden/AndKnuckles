/* Saved palettes, which are the only state the page keeps between visits.

   The paths worth holding are the defensive ones: storage that throws, and
   stored data that is not shaped like a palette. Both are reachable in normal
   use -- a private window blocks storage outright, and the key is plain JSON
   that anyone can edit -- and both must degrade rather than break startup.

   These need the page in a particular state before its script runs, so unlike
   the other DOM tests they open their own page per case. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {PAGE} from './harness.mjs';

const KEY = 'andknuckles.palettes.v1';

/* `before` runs in the page before any of its own script does */
async function load({stored, breakStorage} = {}){
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  if(breakStorage)
    await page.addInitScript(() => {
      const boom = () => { throw new DOMException('denied', 'SecurityError'); };
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: () => ({getItem: boom, setItem: boom, removeItem: boom, key: boom, clear: boom, length: 0}),
      });
    });
  else if(stored !== undefined)
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, stored]);
  await page.goto(PAGE);
  await page.waitForFunction(() => typeof ATLAS_IDX !== 'undefined' && ATLAS_IDX.length > 0,
                             null, {timeout: 15000});
  return {browser, page, errors};
}

const save = (page, name) => page.evaluate(async n => {
  document.getElementById('saveName').value = n;
  document.getElementById('savePal').click();
  await new Promise(r => requestAnimationFrame(r));
}, name);

test('a palette survives a reload, and can be loaded and deleted', async () => {
  const {browser, page} = await load();
  try {
    await page.click('#palette button[data-pal="emerald"]');
    const ramp = await page.evaluate(() => PALETTE.slice(1, 8).map(c => c.join(',')));
    await save(page, 'my ramp');

    assert.deepEqual(await page.evaluate(() => Object.keys(SAVED)), ['my ramp']);
    const stored = await page.evaluate(k => localStorage.getItem(k), KEY);
    assert.ok(stored && JSON.parse(stored)['my ramp'].ramp.length === 7);

    await page.reload();
    await page.waitForFunction(() => typeof SAVED !== 'undefined' && Object.keys(SAVED).length > 0);
    assert.deepEqual(await page.evaluate(() => Object.keys(SAVED)), ['my ramp'],
      'the saved palette did not survive a reload');

    // change the ramp, then load the saved one back
    await page.click('#palette button[data-pal="classic"]');
    assert.notDeepEqual(await page.evaluate(() => PALETTE.slice(1,8).map(c=>c.join(','))), ramp);
    await page.click('#savedList button[data-apply="my ramp"]');
    assert.deepEqual(await page.evaluate(() => PALETTE.slice(1,8).map(c=>c.join(','))), ramp,
      'loading did not restore the ramp');

    await page.click('#savedList button[data-del="my ramp"]');
    assert.deepEqual(await page.evaluate(() => Object.keys(SAVED)), []);
    const after = await page.evaluate(k => localStorage.getItem(k), KEY);
    assert.deepEqual(JSON.parse(after || '{}'), {}, 'delete did not reach storage');
  } finally { await browser.close(); }
});

test('a saved palette keeps its per-line assignments', async () => {
  const {browser, page} = await load();
  try {
    await page.evaluate(() => {
      const ta = document.getElementById('text');
      ta.value = 'SONIC\nKNUCKLES'; ta.dispatchEvent(new Event('input'));
    });
    await page.evaluate(() => {
      state.linePalettes = ['sonic', 'knuckles'];
      renderLineRows(); syncLineChips(); render();
    });
    await save(page, 'two tone');
    assert.deepEqual(await page.evaluate(() => SAVED['two tone'].lines), ['sonic', 'knuckles']);

    await page.evaluate(() => { state.linePalettes = []; render(); });
    await page.click('#savedList button[data-apply="two tone"]');
    assert.deepEqual(await page.evaluate(() => state.linePalettes), ['sonic', 'knuckles'],
      'a two-tone title should come back whole');
  } finally { await browser.close(); }
});

test('storage that throws disables saving instead of breaking the page', async () => {
  const {browser, page, errors} = await load({breakStorage: true});
  try {
    assert.deepEqual(errors, [], 'the page threw during startup');
    assert.equal(await page.evaluate(() => STORAGE_OK), false);
    assert.equal(await page.evaluate(() => document.getElementById('savePal').disabled), true,
      'save should be disabled where it cannot work');
    assert.equal(await page.evaluate(() => document.getElementById('saveNote').hidden), false,
      'and the reason should be visible');
    // the rest of the page still has to work
    await page.evaluate(() => {
      const ta = document.getElementById('text');
      ta.value = 'STILL WORKS'; ta.dispatchEvent(new Event('input'));
    });
    const ink = await page.evaluate(() => {
      const cv = document.getElementById('preview');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0; for(let i = 3; i < d.length; i += 4) if(d[i] > 128) n++;
      return n;
    });
    assert.ok(ink > 500, 'the page should still render with storage unavailable');
  } finally { await browser.close(); }
});

for(const [name, stored] of Object.entries({
  'not JSON':            'this is not json',
  'not an object':       '[1,2,3]',
  'entry is null':       JSON.stringify({a: null}),
  'ramp missing':        JSON.stringify({a: {lines: []}}),
  'ramp wrong length':   JSON.stringify({a: {ramp: [[1,2,3]]}}),
  'ramp not arrays':     JSON.stringify({a: {ramp: ['x','y','z','w','v','u','t']}}),
  'channels far out of range': JSON.stringify({a: {ramp: Array(7).fill([1e9, -1e9, NaN])}}),
})){
  test(`hostile stored data (${name}) is skipped, not fatal`, async () => {
    const {browser, page, errors} = await load({stored});
    try {
      assert.deepEqual(errors, [], 'startup threw');
      const saved = await page.evaluate(() => SAVED);
      for(const v of Object.values(saved)){
        assert.equal(v.ramp.length, 7);
        for(const c of v.ramp){
          assert.equal(c.length, 3);
          for(const n of c) assert.ok(Number.isInteger(n) && n >= 0 && n <= 255, `channel ${n}`);
        }
      }
      // and the page is still usable
      assert.ok(await page.evaluate(() => ATLAS_IDX.length > 0));
    } finally { await browser.close(); }
  });
}
