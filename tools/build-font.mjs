/* Builds the sprite font atlas and glyph table the page embeds.
   Run it with:  node tools/build-font.mjs [outDir]

   Unlike the background builds this one is not a pure decode. The ROM has no
   title font at all -- Map - S3 ANDKnuckles.asm is a flat 168x24 bitmap of the
   phrase, so only & C E K L N S U trace to real game pixels. The rest of the
   alphabet was reconstructed by the ripper, and the digits and punctuation were
   drawn here.

   So the base sheet in font/base/ is data, not something regenerable, and the
   build is additive on top of it:

     1. the ripped sheet             font/base/  (28 glyphs: A-Z, & and ^)
     2. + digits                     font/masks.mjs   -> 38
     3. + keyboard punctuation       font/punct.mjs   -> 68

   Both generated sets are authored as '#' masks at plain size and run through
   the same shading rule, so they cannot drift from the sheet's own weight. Fed
   the real I's outline that rule reproduces the real I pixel for pixel, which is
   what made it safe to point at shapes the game never drew. */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {encodeIndexedPng} from './lib/png.mjs';
import {shade, outline} from './lib/shade.mjs';
import {DIGITS} from './font/masks.mjs';
import {PUNCT} from './font/punct.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(HERE, 'font', 'base') + path.sep;
const OUT  = (process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, 'out')) + path.sep;
fs.mkdirSync(OUT, {recursive: true});

const meta  = JSON.parse(fs.readFileSync(BASE + 'atlas.meta.json'));
const FONT  = JSON.parse(fs.readFileSync(BASE + 'font.json'));
const atlas = new Uint8Array(fs.readFileSync(BASE + 'atlas.idx'));
if(atlas.length !== meta.w * meta.h)
  throw new Error(`base sheet is ${atlas.length} px, expected ${meta.w}x${meta.h}`);

// ---- 0. redrawn diagonals -------------------------------------------------
// Two glyphs the ripper's reconstruction got wrong at the extremes.
//
// W was 44px against M's 26. The sheet builds it as its own V twice, and the two
// coincide exactly: the second V's left stroke lands on the first's right stroke,
// and that coincidence is the middle peak. Overlapping them any tighter smears
// the pair into one band and the peak disappears, so W cannot be narrowed by
// reusing V's pixels -- it has to be redrawn from a narrower V.
//
// X was 16px, the narrowest diagonal in the set, and squeezed that far its two
// strokes had nowhere to go: the interior notch measured 0px on 15 of 18 rows,
// making it a filled bowtie that read as an X only from its outer silhouette.
// With 8px strokes the notch is (width - 16), so 22 is the narrowest that opens
// a 6px counter -- the minimum that survives the outline's 2px-a-side dilation.
//
// Both cost some fidelity. The shading rule reproduces the real I pixel for
// pixel, but I is a vertical bar; on the sheet's diagonals it only matches about
// two thirds to three quarters of the artist's hand-placed rim light (V 66%,
// W 68%, X 73%, A 75%, M 84%). V is left alone for that reason -- it is only
// slightly wider than M. W and X are redrawn because they are the outliers.
const W_WIDTH = 36, X_WIDTH = 22, STROKE = 8;
const vMask = (w, h, s) => {                 // two strokes converging to a point
  const m = new Uint8Array(w*h), shift = (w - s)/2;
  for(let y = 0; y < h; y++){
    const t = y/(h - 1);
    const l = Math.round(t*shift), r = Math.round(w - s - t*shift);
    for(let x = 0; x < s; x++){ m[y*w + l + x] = 1; m[y*w + r + x] = 1; }
  }
  return m;
};
const wMask = (w, h, s) => {                 // two of those sharing the middle peak
  const vw = (w + s)/2, v = vMask(vw, h, s), m = new Uint8Array(w*h);
  for(let y = 0; y < h; y++) for(let x = 0; x < vw; x++) if(v[y*vw + x]){
    m[y*w + x] = 1; m[y*w + x + (vw - s)] = 1;
  }
  return m;
};
const xMask = (w, h, s) => {                 // two crossing diagonals
  const m = new Uint8Array(w*h);
  for(let y = 0; y < h; y++){
    const t = y/(h - 1);
    const a = Math.round((w - s)*t), b = Math.round((w - s)*(1 - t));
    for(let i = 0; i < s; i++){ m[y*w + a + i] = 1; m[y*w + b + i] = 1; }
  }
  return m;
};
const redraw = (ch, mask, width) => {
  const plain = shade(mask, width, 18);
  const ol = outline(plain, width, 18);
  for(const [style, buf, bw, bh] of [['plain', plain, width, 18], ['outline', ol.buf, ol.w, ol.h]]){
    const g = FONT[style].glyphs[ch];
    // redrawing in place only works while the glyph is shrinking; anything wider
    // would run into its neighbour on the sheet
    if(bw > g[2] || bh > g[3])
      throw new Error(`${ch} ${style} would grow to ${bw}x${bh} from ${g[2]}x${g[3]}`);
    for(let y = 0; y < g[3]; y++) for(let x = 0; x < g[2]; x++) atlas[(g[1]+y)*meta.w + g[0]+x] = 0;
    for(let y = 0; y < bh; y++) for(let x = 0; x < bw; x++) atlas[(g[1]+y)*meta.w + g[0]+x] = buf[y*bw + x];
    g[2] = bw;
  }
};
redraw('W', wMask(W_WIDTH, 18, STROKE), W_WIDTH);   // shrinks, so it fits its own slot
if(X_WIDTH - 2*STROKE < 6)
  throw new Error(`X notch would be ${X_WIDTH - 2*STROKE}px, too tight for the outline`);

const maskOf = (rows, name) => {
  const w = rows[0].length;
  if(rows.some(r => r.length !== w)) throw new Error(name + ': ragged rows');
  const m = new Uint8Array(w * rows.length);
  rows.forEach((r, y) => [...r].forEach((c, x) => { if(c === '#') m[y*w + x] = 1; }));
  return {mask: m, w, h: rows.length};
};

// ---- 1. digits -------------------------------------------------------------
// '0' is the real O rather than a redrawn zero, so the two cannot disagree.
const og = FONT.plain.glyphs['O'];
const oMask = new Uint8Array(og[2] * og[3]);
for(let y = 0; y < og[3]; y++) for(let x = 0; x < og[2]; x++)
  oMask[y*og[2] + x] = atlas[(og[1]+y)*meta.w + og[0]+x] ? 1 : 0;

const digits = {};
for(const ch of '0123456789'){
  let m;
  if(ch === '0') m = {mask: oMask, w: og[2], h: og[3]};
  else {
    m = maskOf(DIGITS[ch], ch);
    if(m.h !== 18) throw new Error(`${ch} is ${m.h} rows, want 18`);
  }
  const plain = shade(m.mask, m.w, m.h);
  digits[ch] = {plain: {buf: plain, w: m.w, h: m.h}, outline: outline(plain, m.w, m.h)};
}

const OUT_Y = 114, PLAIN_Y = 140, GAP = 2;
const row = a => a.reduce((s, g) => s + g.w + GAP, GAP);
const dOut = [...'0123456789'].map(c => digits[c].outline);
const dPln = [...'0123456789'].map(c => ({...digits[c].plain, h: 18}));
let W = Math.max(meta.w, row(dOut), row(dPln));
let H = PLAIN_Y + 18 + 2;
let px = new Uint8Array(W * H);
for(let y = 0; y < meta.h; y++) for(let x = 0; x < meta.w; x++) px[y*W + x] = atlas[y*meta.w + x];

const place = (arr, y0) => {
  let x = GAP; const tbl = {};
  arr.forEach((g, i) => {
    for(let yy = 0; yy < g.h; yy++) for(let xx = 0; xx < g.w; xx++){
      const v = g.buf[yy*g.w + xx]; if(v) px[(y0+yy)*W + x+xx] = v;
    }
    tbl['0123456789'[i]] = [x, y0, g.w, g.h, 0];
    x += g.w + GAP;
  });
  return tbl;
};
const oMeta = place(dOut, OUT_Y), pMeta = place(dPln, PLAIN_Y);
// a glyph taller than its style's row height would push the line apart
for(const [ch, g] of Object.entries(oMeta)) if(g[3] !== FONT.outline.rowh) throw new Error('outline ' + ch + ' h=' + g[3]);
for(const [ch, g] of Object.entries(pMeta)) if(g[3] !== FONT.plain.rowh)   throw new Error('plain ' + ch + ' h=' + g[3]);
Object.assign(FONT.outline.glyphs, oMeta);
Object.assign(FONT.plain.glyphs,   pMeta);

// ---- 2. punctuation --------------------------------------------------------
const punct = {};
for(const [ch, g] of Object.entries(PUNCT)){
  const m = maskOf(g.rows, ch);
  const plain = shade(m.mask, m.w, m.h);
  punct[ch] = {plain: {buf: plain, w: m.w, h: m.h, y: g.y},
               outline: {...outline(plain, m.w, m.h), y: g.y}};
}
const order = Object.keys(PUNCT);
const pack = (key, bandH, startY) => {
  const placed = {}; let x = GAP, y = startY, rowH = 0;
  for(const ch of order){
    const g = punct[ch][key];
    if(x + g.w + GAP > W){ x = GAP; y += rowH + GAP; rowH = 0; }
    placed[ch] = {x, y, g};
    x += g.w + GAP;
    rowH = Math.max(rowH, bandH);
  }
  return {placed, endY: y + rowH + GAP};
};
const packO = pack('outline', 22, H + GAP);
const packP = pack('plain',   18, packO.endY);
const grown = new Uint8Array(W * packP.endY);
grown.set(px, 0);
px = grown; H = packP.endY;

const write = (placed, tbl, rowh) => {
  for(const ch of order){
    const {x, y, g} = placed[ch];
    for(let yy = 0; yy < g.h; yy++) for(let xx = 0; xx < g.w; xx++){
      const v = g.buf[yy*g.w + xx]; if(v) px[(y+yy)*W + x+xx] = v;
    }
    // [sx, sy, w, h, yOffset] -- the offset seats short glyphs in the row band,
    // so a period sits on the baseline and a quote at cap height with no padding
    tbl[ch] = [x, y, g.w, g.h, g.y];
    if(g.y + g.h > rowh) throw new Error(`${ch} overflows the ${rowh}px band: ${g.y}+${g.h}`);
  }
};
write(packO.placed, FONT.outline.glyphs, FONT.outline.rowh);
write(packP.placed, FONT.plain.glyphs,   FONT.plain.rowh);

// ---- 3. the diagonal that grew --------------------------------------------
// X goes the other way -- 16 to 22 -- so it cannot go back in its own slot: at 22
// plain it would abut Y, and at 26 outline it would overlap it. Appended below
// the punctuation instead, and its old slot cleared so no orphan pixels are left
// sitting in the sheet.
{
  const xp = shade(xMask(X_WIDTH, 18, STROKE), X_WIDTH, 18);
  const xo = outline(xp, X_WIDTH, 18);
  const bandH = Math.max(18, xo.h);
  const grown2 = new Uint8Array(W * (H + bandH + GAP));
  grown2.set(px, 0);
  px = grown2;
  const y0 = H + GAP;
  let x = GAP;
  for(const [style, buf, bw, bh] of [['plain', xp, X_WIDTH, 18], ['outline', xo.buf, xo.w, xo.h]]){
    const old = FONT[style].glyphs['X'];
    for(let yy = 0; yy < old[3]; yy++) for(let xx = 0; xx < old[2]; xx++)
      px[(old[1]+yy)*W + old[0]+xx] = 0;
    for(let yy = 0; yy < bh; yy++) for(let xx = 0; xx < bw; xx++){
      const v = buf[yy*bw + xx]; if(v) px[(y0+yy)*W + x+xx] = v;
    }
    FONT[style].glyphs['X'] = [x, y0, bw, bh, 0];
    if(bh !== FONT[style].rowh) throw new Error(`X ${style} h=${bh} but rowh=${FONT[style].rowh}`);
    x += bw + GAP;
  }
  if(x > W) throw new Error('X band overflows the sheet width');
  H += bandH + GAP;
}

const png = encodeIndexedPng(px, W, H, meta.pal, 0);
fs.writeFileSync(OUT + 'font-atlas.png', png);
fs.writeFileSync(OUT + 'font-table.json', JSON.stringify(FONT));
const n = Object.keys(FONT.plain.glyphs).length;
if(n !== Object.keys(FONT.outline.glyphs).length) throw new Error('styles disagree on glyph count');
console.log(`font-atlas.png  ${W}x${H}  ${png.length}B  ${n} glyphs per style`);
