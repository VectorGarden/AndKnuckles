/* Builds the title-card lettering -- the tall face S3&K writes zone names in,
   ANGEL ISLAND ZONE -- as a second text style.
   Run it with:  node tools/build-card-font.mjs [outDir]

   Unlike the S3 title font, this one is a decode. There is no font in the ROM
   as such: each zone name is a mapping frame in Map - Title Card.asm, built from
   letter pieces over that zone's own small letter set (loaded at tile $54D) and
   the shared title-card art below it (Red ACT at $500, the ZONE letters at $510,
   the act number at $53D, in that order, later loads winning). So the build
   renders every name, splits it back into letters, and keeps one of each.

   Splitting: pieces never cut a letter, but one piece can hold several -- in
   MUSHROOM HILL one 32px piece is H, I and L. Words are runs of touching pieces.
   Where a word has one piece per letter, those pieces give the letters' widths;
   with the widths known, every other word splits by position. Every letter must
   then come out pixel-identical wherever it appears, or the build stops.

   The zone names spell 22 letters. J, Q, W and X never appear, so they are
   derived here, in the style's own construction (see the bottom of the file).

   Writes card-atlas.png (indexed, the title card's real colours) and
   card-table.json (the same shape as the main font's table). */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {kosMDecode} from './lib/kosinski.mjs';
import {encodeIndexedPng} from './lib/png.mjs';
import {parseMapTables, renderFrame} from './lib/sprite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D    = path.join(HERE, 'rom') + path.sep;
const OUT  = (process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, 'out')) + path.sep;
fs.mkdirSync(OUT, {recursive: true});
const kos = f => kosMDecode(fs.readFileSync(D + f));

const map = parseMapTables(fs.readFileSync(D + 'TitleCard_map.asm', 'utf8')).Map_TitleCard;
// Obj_TitleCard's Queue_Kos_Module calls, in order
// `shared` is what loads at $510 over Red ACT: S3&K's file, S&K-alone's, or --
// for Sonic 3 alone, which loads nothing there -- none. It holds the ZONE letters
// and the banner's emblem, and only the emblem differs between the three.
function vram(zone, shared = 'TitleCard_S3KZone.kosm'){
  const v = new Uint8Array(0x600*32);
  v.set(kos('TitleCard_RedAct.kosm'),  0x500*32);
  if(shared) v.set(kos(shared), 0x510*32);
  v.set(kos('TitleCard_Number1.kosm'), 0x53D*32);
  if(zone) v.set(kos(`TitleCard_${zone}.kosm`), 0x54D*32);
  return v;
}
// Map_TitleCard frames 4.. are the zones in zone order; 3 is ZONE.
const NAMES = [['ANGEL ISLAND','AIZ'],['HYDROCITY','HCZ'],['MARBLE GARDEN','MGZ'],['CARNIVAL NIGHT','CNZ'],
  ['FLYING BATTERY','FBZ'],['ICECAP','ICZ'],['LAUNCH BASE','LBZ'],['MUSHROOM HILL','MHZ'],['SANDOPOLIS','SOZ'],
  ['LAVA REEF','LRZ'],['SKY SANCTUARY','SSZ'],['DEATH EGG','DEZ'],['THE DOOMSDAY','DDZ'],['HIDDEN PALACE','HPZ']];
const jobs = NAMES.map(([name, z], i) => ({name, frame: map[4 + i], v: vram(z)}));
jobs.push({name: 'ZONE', frame: map[3], v: vram(null)});

const H = 24;
const xOf = p => { const X = (p[4] << 8) | p[5]; return X > 32767 ? X - 65536 : X; };
const wOf = p => (((p[1] >> 2) & 3) + 1) * 8;
for(const j of jobs){
  const ps = j.frame.map(p => ({p, x: xOf(p), w: wOf(p)})).sort((a, b) => a.x - b.x);
  if(ps.some(q => ((q.p[1] & 3) + 1) * 8 !== H)) throw new Error(j.name + ': a piece is not 24px tall');
  j.words = [];
  for(const q of ps){
    const w = j.words[j.words.length - 1];
    if(w && q.x === w[w.length-1].x + w[w.length-1].w) w.push(q); else j.words.push([q]);
  }
  j.letters = j.name.split(' ');
  if(j.words.length !== j.letters.length) throw new Error(`${j.name}: ${j.words.length} runs of pieces for ${j.letters.length} words`);
}
const width = {};
for(const j of jobs) j.words.forEach((ps, i) => {
  if(ps.length !== j.letters[i].length) return;
  ps.forEach((q, k) => {
    const L = j.letters[i][k];
    if(width[L] && width[L] !== q.w) throw new Error(`${L} is ${width[L]}px in one name and ${q.w}px in another`);
    width[L] = q.w;
  });
});
const glyphs = {};
for(const j of jobs) j.words.forEach((ps, i) => {
  const word = j.letters[i], total = ps.reduce((a, q) => a + q.w, 0);
  for(const L of word) if(!width[L]) throw new Error(`${j.name}: no width for ${L}`);
  if([...word].reduce((a, L) => a + width[L], 0) !== total) throw new Error(`${j.name}: ${word} does not fill its pieces`);
  const r = renderFrame(ps.map(q => q.p), j.v);
  let x = 0;
  for(const L of word){
    const w = width[L], px = new Uint8Array(w * H);
    for(let y = 0; y < H; y++) for(let k = 0; k < w; k++) px[y*w + k] = r.px[y*r.w + x + k] & 15;
    if(glyphs[L] && Buffer.compare(Buffer.from(glyphs[L].px), Buffer.from(px)))
      throw new Error(`${L} differs between ${glyphs[L].from} and ${j.name}`);
    if(!glyphs[L]) glyphs[L] = {w, px, from: j.name};
    x += w;
  }
});
console.log(`  ${Object.keys(glyphs).length} letters from ${jobs.length} names: ${Object.keys(glyphs).sort().join('')}`);

// ---- the four the game never needed --------------------------------------------
// Colour indices, all palette line 0 (Sonic's, which the title card is drawn in):
// 1 face $EEE, 12 and 13 the light and mid anti-aliasing $ECC / $CAA, 15 the
// $222 block behind rows 8-23 -- the bar the name sits on, built into each glyph.
const FACE = 1, AA1 = 12, AA2 = 13, BAR = 15, BAR_TOP = 8;
const toMask = g => Array.from({length: H}, (_, y) =>
  Array.from({length: g.w}, (_, x) => ({[FACE]: '#', [AA1]: 'a', [AA2]: 'b'})[g.px[y*g.w + x]] || '.').join(''));
function fromMask(rows){
  const w = rows[0].length, px = new Uint8Array(w * H);
  rows.forEach((r, y) => [...r].forEach((c, x) => {
    px[y*w + x] = c === '#' ? FACE : c === 'a' ? AA1 : c === 'b' ? AA2 : y >= BAR_TOP ? BAR : 0;
  }));
  return {w, px};
}
// A diagonal stroke the way the real letters are anti-aliased. Supersampled
// coverage of a band 2.1px wide, cut at 0.8 / 0.5 / 0.1: with its centre run
// from x 1.95 to 7.95 over the 24 rows, this reproduces V's left stroke exactly.
function strokeCov(w, x0, x1, y0 = 0, y1 = H){
  const cov = Array.from({length: H}, () => new Float64Array(w));
  for(let y = y0; y < y1; y++) for(let sy = 0; sy < 8; sy++){
    const yy = y + (sy + 0.5)/8, c = x0 + (x1 - x0) * (yy - y0) / (y1 - y0);
    for(let x = 0; x < w; x++) for(let sx = 0; sx < 8; sx++)
      if(Math.abs(x + (sx + 0.5)/8 - c) <= 1.05) cov[y][x] += 1/64;
  }
  return cov;
}
const level = c => c >= 0.8 ? 3 : c >= 0.5 ? 2 : c >= 0.1 ? 1 : 0;
const RANK = {'.': 0, b: 1, a: 2, '#': 3}, CHAR = ['.', 'b', 'a', '#'];
// lay strokes over a mask, keeping the stronger of the two at each pixel
function overlay(rows, ...covs){
  return rows.map((r, y) => [...r].map((c, x) =>
    CHAR[Math.max(RANK[c], ...covs.map(cv => level(cv[y][x])))]).join(''));
}
{
  const check = overlay(Array(H).fill('.'.repeat(8)), strokeCov(8, 1.95, 7.95));
  const real = toMask(glyphs.V).map(r => r.slice(0, 8));
  if(check.some((r, y) => r !== real[y].replace(/[^#ab]/g, '.')))
    throw new Error('the stroke rule no longer reproduces V');
}
// W is M upside down: M is two peaks, W two valleys. The bar stays where it is.
glyphs.W = {...fromMask(toMask(glyphs.M).slice().reverse()), from: 'M, flipped'};
// J is U without its left stem above the hook.
glyphs.J = {...fromMask(toMask(glyphs.U).map((r, y) => y < 18 ? '.' + '.'.repeat(2) + r.slice(3) : r)), from: 'U, left stem cut'};
// X is V's two strokes run corner to corner, crossing at mid-height.
glyphs.X = {...fromMask(overlay(Array(H).fill('.'.repeat(16)),
  strokeCov(16, 1.95, 11.05), strokeCov(16, 11.05, 1.95))), from: 'drawn'};
// Q is O with a short tail through its lower right, at V's stroke weight.
glyphs.Q = {...fromMask(overlay(toMask(glyphs.O), strokeCov(24, 13.5, 19.5, 15, 24))), from: 'O + tail'};

// ---- & and punctuation, which the title card never drew -------------------------------
// Built from three primitives at the same weight and cut-offs as the strokes above:
// a segment and a box, and an elliptical arc which, run as a whole ellipse, lands
// within one shade of the real O on all but 36 of its 576 pixels. Angles are
// degrees clockwise from the right, since y runs down.
const HW = 1.05;
function shape(w, ...parts){
  const cov = Array.from({length: H}, () => new Float64Array(w));
  for(let y = 0; y < H; y++) for(let x = 0; x < w; x++){
    let c = 0;
    for(let sy = 0; sy < 8; sy++) for(let sx = 0; sx < 8; sx++){
      const X = x + (sx + 0.5)/8, Y = y + (sy + 0.5)/8;
      if(parts.some(f => f(X, Y))) c += 1/64;
    }
    cov[y][x] = c;
  }
  return {...fromMask(cov.map(r => Array.from(r, c => CHAR[level(c)]).join(''))), from: 'drawn'};
}
const seg = (x0, y0, x1, y1) => (X, Y) => {
  const dx = x1 - x0, dy = y1 - y0, t = Math.max(0, Math.min(1, ((X-x0)*dx + (Y-y0)*dy) / (dx*dx + dy*dy)));
  return Math.hypot(X - (x0 + t*dx), Y - (y0 + t*dy)) <= HW;
};
const arc = (cx, cy, rx, ry, a0, a1) => (X, Y) => {
  const nx = (X - cx)/rx, ny = (Y - cy)/ry, t = Math.atan2(ny, nx);
  let deg = t * 180 / Math.PI; if(deg < 0) deg += 360;
  if(a0 <= a1 ? deg < a0 || deg > a1 : deg < a0 && deg > a1) return false;
  return Math.abs(Math.hypot(nx, ny) - 1) * Math.hypot(rx*Math.cos(t), ry*Math.sin(t)) <= HW;
};
const box = (x0, y0, x1, y1) => (X, Y) => X >= x0 && X < x1 && Y >= y0 && Y < y1;
{
  const ring = arc(12, 12, 11.25, 11.5, 0, 360), real = toMask(glyphs.O);
  const drawn = toMask(shape(24, ring));
  let off = 0; for(let y = 0; y < H; y++) for(let x = 0; x < 24; x++) if(drawn[y][x] !== real[y][x].replace(/[^#ab]/g, '.')) off++;
  if(off > 36) throw new Error(`the arc rule has drifted from O: ${off} pixels`);
}
// The style keeps its features small and high -- B's upper bowl, A's bar at row 7 --
// with long strokes below, so & is a small loop on top, a tall bowl, and a leg out
// to the bottom right: one crossing, where the leg leaves the bowl.
glyphs['&'] = shape(16, arc(5.6, 4.0, 3.0, 3.6, 0, 360), seg(6.9, 7.4, 13.6, 23.4),
                        arc(5.6, 16.6, 4.4, 6.4, 330, 215), seg(3.6, 7.2, 2.0, 11.0));
glyphs['.'] = shape(4, box(1, 22, 3, 24));
glyphs[','] = shape(5, box(1, 20, 3, 22), seg(2.5, 21.5, 1.2, 23.6));
glyphs["'"] = shape(4, box(1, 0, 3, 6));
glyphs['"'] = shape(7, box(1, 0, 3, 6), box(4, 0, 6, 6));
glyphs['!'] = shape(4, box(1, 0, 3, 18), box(1, 22, 3, 24));
glyphs[':'] = shape(4, box(1, 9, 3, 11), box(1, 22, 3, 24));
glyphs['-'] = shape(10, box(1, 13, 9, 15));
glyphs['?'] = shape(14, arc(6.2, 5.2, 4.6, 4.6, 180, 100), box(5.2, 10, 7.2, 18), box(5.2, 22, 7.2, 24));

// ---- write ------------------------------------------------------------------------
const order = Object.keys(glyphs).sort();
const AW = order.reduce((a, L) => a + glyphs[L].w + 2, 0), atlas = new Uint8Array(AW * H);
const table = {rowh: H, glyphs: {}};
let x = 0;
for(const L of order){
  const g = glyphs[L];
  for(let y = 0; y < H; y++) atlas.set(g.px.subarray(y*g.w, (y+1)*g.w), y*AW + x);
  table.glyphs[L] = [x, 0, g.w, H, 0];
  x += g.w + 2;
}
// The title card is drawn in palette line 0 -- Pal_SonicTails, Sonic's line.
const SONIC = [0x000,0xEEE,0xE66,0xC42,0x822,0x080,0x00E,0x008,0x0AE,0x08E,0x8AE,0x46A,0xECC,0xCAA,0x866,0x222];
const pal = SONIC.map(w => [((w >> 1) & 7)*36, ((w >> 5) & 7)*36, ((w >> 9) & 7)*36]);
fs.writeFileSync(OUT + 'card-atlas.png', encodeIndexedPng(atlas, AW, H, pal, 0));
console.log(`card-atlas.png  ${AW}x${H}  ${fs.statSync(OUT + 'card-atlas.png').size}B  ${order.length} glyphs`);

// ---- the rest of the card -----------------------------------------------------------
// The red banner (frame 1), ZONE (frame 3) and the ACT number (frame 2, over Number 1
// or Number 2 at $53D), each written as its own image with its offset from the
// object's origin, so the page can slide them the way their objects move. The
// banner comes three ways, one per game, by what Obj_TitleCard loads at $510:
// SONIC 3 (Sonic 3 alone, nothing loaded over Red ACT), SONIC 3 & KNUCKLES, and
// SONIC & KNUCKLES (ArtKosM_TitleCardSKZone, when SK_alone_flag is set).
table.parts = {};
for(const [name, frame, number, shared] of [
  ['banner-s3', 1, 0, null], ['banner-s3k', 1], ['banner-sk', 1, 0, 'TitleCard_SKZone.kosm'],
  ['zone', 3], ['act1', 2, 1], ['act2', 2, 2]]){
  const v = vram(null, shared);
  if(number) v.set(kos(`TitleCard_Number${number}.kosm`), 0x53D*32);
  const r = renderFrame(map[frame], v);
  for(let i = 0; i < r.px.length; i++) r.px[i] &= 15;
  fs.writeFileSync(OUT + `card-${name}.png`, encodeIndexedPng(r.px, r.w, r.h, pal, 0));
  table.parts[name] = {ox: r.ox, oy: r.oy, w: r.w, h: r.h};
  console.log(`card-${name}.png`.padEnd(16) + ` ${String(r.w).padStart(3)}x${r.h}  @${r.ox},${r.oy}`);
}
// ObjArray_TtlCard: where each element starts and rests (screen coordinates, the
// $80 sprite origin already taken off), and its place in the exit order -- the
// element leaves once the card's exit counter reaches it. The name's art is ours:
// every zone-name frame ends at x +128 from its origin, so names right-align there.
table.card = {
  banner: {x: 0xE0 - 0x80, from: 0x10 - 0x80, to: 0xC0 - 0x80, order: 1},   // slides down
  name:   {y: 0xE0 - 0x80, from: 0x260 - 0x80, to: 0x120 - 0x80, order: 3, right: 128},
  zone:   {y: 0x100 - 0x80, from: 0x2FC - 0x80, to: 0x17C - 0x80, order: 5},
  act:    {y: 0x120 - 0x80, from: 0x344 - 0x80, to: 0x184 - 0x80, order: 7},
  speedIn: 0x10, speedOut: 0x20, hold: 90,                                  // Obj_TitleCardElement, $2E
};
fs.writeFileSync(OUT + 'card-table.json', JSON.stringify(table));
for(const L of ['J','Q','W','X']) console.log(`  ${L}: ${glyphs[L].from}`);
console.log(`  drawn: & . , ' " ! ? : -`);
