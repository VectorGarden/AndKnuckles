/* Builds the Sonic 1 title screen and the Sonic 1 credits lettering.
   Run it with:  node tools/build-s1-assets.mjs [outDir]

   From sonicretro/s1disasm (REV01, bugs kept -- it is the game people played):

     s1-bg.png        plane B: the GHZ background as GM_Title first draws it,
                      512px of BG layout, from plane y 8 (BG V-scroll is a
                      constant 8 here) down 224 lines
     s1-emblem.png    plane A: Eni_Title, the emblem, 34x22 cells at cell (3,4)
     s1-sonic0-7.png  TitleSonic's eight mapping frames
     s1-tm.png        the TM
     s1-still.png     the title at rest, for still mode
     s1-meta.json     palettes, sprite offsets, timeline constants

   The layers are palette-index images (grey g*4) like AIZ's, since the screen
   fades in and its water colours cycle; the page colours each frame.

   And the credits face -- SONIC TEAM PRESENTS, the staff roll -- as a letter
   style: cred-atlas.png and cred-table.json. Its letters come straight from the
   credits mappings, whose pieces each carry the character in a comment. The roll
   never spells Q, V, W or Z, or any digit but 2, or any punctuation, so those are
   derived at the bottom of the file. */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {kosDecode} from './lib/kosinski.mjs';
import {eniDecode} from './lib/enigma.mjs';
import {nemDecode} from './lib/nemesis.mjs';
import {encodeIndexedPng} from './lib/png.mjs';
import {parseS1MapFrames, renderFrame} from './lib/sprite.mjs';
import {DESIGNS, SMALL} from './font/s1-logo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D    = path.join(HERE, 'rom') + path.sep;
const OUT  = (process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, 'out')) + path.sep;
fs.mkdirSync(OUT, {recursive: true});
const rd = f => fs.readFileSync(D + f);
const words = b => Array.from({length: b.length >> 1}, (_, i) => b.readUInt16BE(i*2));
const rgb = w => [((w >> 1) & 7)*36, ((w >> 5) & 7)*36, ((w >> 9) & 7)*36];
const KEY = Array.from({length: 64}, (_, g) => [g*4, g*4, g*4]);
const W = 320, H = 224;
function writeIdx(file, px, w, h){
  fs.writeFileSync(OUT + file, encodeIndexedPng(px, w, h, KEY, 0));
  console.log(`${file.padEnd(16)} ${String(w).padStart(3)}x${String(h).padStart(3)}  ${String(fs.statSync(OUT + file).size).padStart(6)}B`);
}

// ---- plane B: the GHZ background ---------------------------------------------------
// Blk16_GHZ (Enigma) blocks of four nametable words; Blk256_GHZ (Kosinski) chunks of
// 16x16 block words, whose bits 13-14 are solidity and masked off for drawing; the BG
// layout is width-1, height-1, then chunk IDs, 0 empty and 1-based.
const tiles  = nemDecode(rd('S1_GHZ1.nem'));                     // Nem_GHZ_1st only
const blocks = eniDecode(rd('S1_GHZ_Blocks.eni'), 0);
const chunks = Buffer.from(kosDecode(rd('S1_GHZ_Chunks.kos')).data);
const lay    = rd('S1_GHZ_BG.bin');
const layW = lay[0] + 1, layH = lay[1] + 1;
function bgWord(x, y){
  const row = y >> 8, col = (x >> 8) % layW;
  if(row >= layH) return 0;
  const id = lay[2 + row*layW + col] & 0x7F;
  if(!id) return 0;
  const cw = chunks.readUInt16BE((id - 1)*0x200 + ((y >> 4) & 15)*32 + ((x >> 4) & 15)*2);
  const b = cw & 0x3FF;
  let qx = (x >> 3) & 1, qy = (y >> 3) & 1;
  if(cw & 0x800) qx ^= 1;
  if(cw & 0x1000) qy ^= 1;
  let w = blocks[b*4 + qy*2 + qx];
  if(cw & 0x800) w ^= 0x800;
  if(cw & 0x1000) w ^= 0x1000;
  return w;
}
// GM_Title's DrawChunks fills the 512px plane once from BG x 0; afterwards only
// the hills strip is redrawn, a column at a time, and only once the camera has
// carried bg2x+320 past 512 does that column differ from the first draw. The
// page's timeline stops well short of it (asserted below), so one 512px strip,
// wrapped, is the plane exactly.
const BG_Y = 8, BG_W = 512;
const bg = new Uint8Array(BG_W * H);
for(let y = 0; y < H; y++) for(let x = 0; x < BG_W; x++){
  const Y = y + BG_Y, w = bgWord(x, Y), t = w & 0x7FF;
  if(w & 0x8000) throw new Error('a background tile is high priority');
  const sx = w & 0x800 ? 7 - (x & 7) : x & 7, sy = w & 0x1000 ? 7 - (Y & 7) : Y & 7;
  const b = tiles[t*32 + sy*4 + (sx >> 1)], c = sx & 1 ? b & 15 : b >> 4;
  if(c) bg[y*BG_W + x] = ((w >> 13) & 3)*16 + c;
}
writeIdx('s1-bg.png', bg, BG_W, H);

// ---- plane A: the emblem -------------------------------------------------------------
// Eni_Title's words already carry the emblem's $200 tile base (tile 0 is blank VRAM),
// all palette line 0, priority 0, X-flip the only flag. Copied to vram_fg+$206:
// cell (3,4), so the emblem sits 8px left of centre, as it does in the game.
const fg = nemDecode(rd('S1_TitleFg.nem'));
const emb = eniDecode(rd('S1_Title.eni'), 0);
const EW = 34, EH = 22;
if(emb.length !== EW*EH) throw new Error('emblem map is ' + emb.length + ' words');
const EX = 3*8, EY = 4*8;
const emblem = new Uint8Array(EW*8 * EH*8);
emb.forEach((w, i) => {
  const t = w & 0x7FF; if(!t) return;
  if(w & 0x9000) throw new Error('emblem tile has priority or Y-flip');
  const cx = (i % EW)*8, cy = Math.floor(i / EW)*8, a = (t - 0x200)*32;
  for(let y = 0; y < 8; y++) for(let x = 0; x < 8; x++){
    const sx = w & 0x800 ? 7 - x : x, b = fg[a + y*4 + (sx >> 1)], c = sx & 1 ? b & 15 : b >> 4;
    if(c) emblem[(cy + y)*EW*8 + cx + x] = ((w >> 13) & 3)*16 + c;
  }
});
writeIdx('s1-emblem.png', emblem, EW*8, EH*8);

// ---- sprites ---------------------------------------------------------------------------
// TitleSonic: Nem_TitleSonic at $300 on palette line 1, eight frames, all pieces at
// positive offsets from its origin, screen x $70. The TM: Nem_TitleTM at $510, line 1.
const meta = {sonic: [], tm: null};
const sonicArt = nemDecode(rd('S1_TitleSonic.nem'));
parseS1MapFrames(rd('S1_TitleSonic_map.asm').toString()).forEach((f, i) => {
  const r = renderFrame(f, sonicArt, {line: 1});
  writeIdx(`s1-sonic${i}.png`, r.px, r.w, r.h);
  meta.sonic.push({ox: r.ox, oy: r.oy, w: r.w, h: r.h});
});
{
  const f = parseS1MapFrames(rd('S1_PressStartTM_map.asm').toString())[3];   // frame 3: TM
  const r = renderFrame(f, nemDecode(rd('S1_TitleTM.nem')), {line: 1});
  writeIdx('s1-tm.png', r.px, r.w, r.h);
  meta.tm = {x: 0xF0 + r.ox, y: 0x78 + r.oy};                // obX $80+$F0, obScreenY $80+$78
}

// ---- palettes ----------------------------------------------------------------------------
// palid_Title, faded in by PaletteFadeIn: 22 steps, each colour +$200 (blue) if it fits,
// else +$20, else +2, whole-word compares, from black. Then PalCycle_Title rotates line 2
// colours 8-11 through Cycle - Title Screen Water every 6 frames: four states.
const target = words(rd('S1_Pal_Title.bin'));
const water  = words(rd('S1_Pal_TitleWater.bin'));
if(target.length !== 64 || water.length !== 16) throw new Error('unexpected S1 palette sizes');
const pals = [], hex = p => p.map(c => c.toString(16).padStart(3, '0')).join('');
const hexToPal = h => Array.from({length: 64}, (_, i) => rgb(parseInt(h.slice(i*3, i*3 + 3), 16)));
let cur = new Array(64).fill(0);
for(let s = 0; s < 22; s++){
  pals.push(hex(cur));                                        // display frame s shows step s
  cur = cur.map((c, i) => { const t = target[i];
    return c === t ? c : c + 0x200 <= t ? c + 0x200 : c + 0x20 <= t ? c + 0x20 : c + 2; });
}
if(hex(cur) !== hex(target)) throw new Error('the fade does not land on the title palette');
for(let k = 0; k < 4; k++){
  const p = target.slice(); for(let i = 0; i < 4; i++) p[32 + 8 + i] = water[k*4 + i];
  pals.push(hex(p));
}
meta.pals = pals;
meta.fadeFrames = 22;

// ---- the timeline's constants ----------------------------------------------------------
// Main-loop iteration T shows on display frame 22+T (frame 22 is the pre-loop state).
// TitleSonic: hidden until T=29, at screen y 94 rising 8/frame to 22 by T=38; frame 0
// until T=46, appear frames 1-5 at 8 each, then 6/7 every 8 from T=86 (Ani_TSon). The
// camera follows an empty object moving 2px/frame: camX = 2(T-41) from T=42. Deform_GHZ:
// bg2x = camX/2, bg3x = 3/8 camX, three cloud bands auto-scrolling by deform call n=T+2.
// The 30-sprite line-limit mask hides Sonic on lines 104-199.
meta.sonicX = 0x70; meta.sonicY = 0x5E; meta.sonicTop = 0x16;
meta.appear = 29; meta.frame1 = 46; meta.wag = 86; meta.camStart = 41;
meta.maskTop = 104; meta.maskBottom = 200; meta.emblem = {x: EX, y: EY};
meta.intro = 22 + meta.wag;                                   // the text springs in as he starts to wag
const LAST_T = meta.wag + 120;                                // spring plus slack
if((LAST_T - meta.camStart) + 320 >= BG_W)
  throw new Error('the timeline runs into the plane-B column redraws; emulate the plane');

// ---- the still: settled, mid-wag ----------------------------------------------------------
{
  const T = meta.wag, out = new Uint8Array(W * H).fill(32);   // backdrop: line 2 colour 0
  const camX = Math.max(0, 2*(T - meta.camStart)), bg2 = camX/2, bg3 = Math.floor(0.75*Math.max(0, T - meta.camStart));
  const n = T + 2, cU = n, cM = Math.floor(0.75*n), cL = n >> 1;
  const q = Math.trunc((bg2 << 8) / 0x68), step = q << 8;
  for(let y = 0; y < H; y++){
    const s = y < 24 ? cU + bg3 : y < 40 ? cM + bg3 : y < 56 ? cL + bg3 : y < 104 ? bg3 : y < 144 ? bg2
            : (((bg2 << 16) + (y - 144)*step) >> 16);
    for(let x = 0; x < W; x++){ const v = bg[y*BG_W + ((x + s) & 511)]; if(v) out[y*W + x] = v; }
  }
  for(let y = 0; y < EH*8; y++) for(let x = 0; x < EW*8; x++){ const v = emblem[y*EW*8 + x]; if(v) out[(EY + y)*W + EX + x] = v; }
  const f = parseS1MapFrames(rd('S1_TitleSonic_map.asm').toString())[6], r = renderFrame(f, sonicArt, {line: 1});
  for(let y = 0; y < r.h; y++) for(let x = 0; x < r.w; x++){
    const v = r.px[y*r.w + x], X = meta.sonicX + r.ox + x, Y = meta.sonicTop + r.oy + y;
    if(v && Y < meta.maskTop) out[Y*W + X] = v;
  }
  const tm = renderFrame(parseS1MapFrames(rd('S1_PressStartTM_map.asm').toString())[3], nemDecode(rd('S1_TitleTM.nem')), {line: 1});
  for(let y = 0; y < tm.h; y++) for(let x = 0; x < tm.w; x++){ const v = tm.px[y*tm.w + x]; if(v) out[(meta.tm.y + y)*W + meta.tm.x + x] = v; }
  // the water colours PalCycle_Title has reached by then: a step every 6 frames from T=1
  const pal = hexToPal(pals[22 + (Math.floor((T - 1)/6) & 3)]);
  fs.writeFileSync(OUT + 's1-still.png', encodeIndexedPng(out, W, H, pal, -1));
  console.log(`s1-still.png     320x224  ${fs.statSync(OUT + 's1-still.png').size}B`);
}
fs.writeFileSync(OUT + 's1-meta.json', JSON.stringify(meta));

// ---- the credits face -----------------------------------------------------------------------
// Each piece in Map_Cred is commented with its character. 16px tall; I is one tile wide,
// M three. D comes two ways: $54, only in SOUND, is $42 with its right column cleared --
// the regular one is kept.
const credArt = nemDecode(rd('S1_Credits.nem'));
const credText = rd('S1_Credits_map.asm').toString();
const found = {};
for(const m of credText.matchAll(/spritePiece\s+([^;\n]+);\s*(\S)\s*$/gm)){
  const f = m[1].split(',').map(s => s.trim());
  const key = [f[2], f[3], f[4]].join(',');
  (found[m[2]] ??= new Set()).add(key);
}
const cglyphs = {};
for(const [ch, keys] of Object.entries(found)){
  const pick = ch === 'D' ? [...keys].find(k => k.endsWith('$42')) : [...keys][0];
  if(keys.size > 1 && ch !== 'D') throw new Error(`credits ${ch} has ${keys.size} tile sets`);
  const [w, h, t] = pick.split(',').map(v => v.startsWith('$') ? parseInt(v.slice(1), 16) : +v);
  const r = renderFrame([[0, ((w-1) << 2) | (h-1), t >> 8, t & 0xFF, 0, 0]], credArt);
  cglyphs[ch] = {w: r.w, px: Array.from(r.px, v => v & 15), from: 'credits'};
}
console.log(`  credits: ${Object.keys(cglyphs).sort().join('')} decoded`);

// The face is a bevel round a black interior: one step out (diagonals too) is the white
// rim, two steps the mid blue -- a shade darker at an exact diagonal corner -- and three
// the outline. Run on the interiors of the real L, T, H and E it lands within 8 pixels
// of each; the artist shaded a few right edges darker by hand. Derived glyphs are drawn
// as interiors, 10 rows tall, and bevelled by it.
function bevel(rows){
  const ih = rows.length, iw = rows[0].length, w = iw + 6, h = 16, px = new Array(w*h).fill(0);
  const inside = (x, y) => { const ix = x - 3, iy = y - 3; return ix >= 0 && iy >= 0 && ix < iw && iy < ih && rows[iy][ix] === '#'; };
  for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
    if(inside(x, y)){ px[y*w + x] = 1; continue; }
    let best = 9, corner = true;
    for(let dy = -3; dy <= 3; dy++) for(let dx = -3; dx <= 3; dx++) if(inside(x + dx, y + dy)){
      const c = Math.max(Math.abs(dx), Math.abs(dy));
      if(c < best){ best = c; corner = Math.abs(dx) === Math.abs(dy); }
      else if(c === best && Math.abs(dx) !== Math.abs(dy)) corner = false;
    }
    px[y*w + x] = best === 1 ? 6 : best === 2 ? (corner ? 4 : 5) : best === 3 ? 2 : 0;
  }
  return {w, px};
}
const interiorOf = g => Array.from({length: 10}, (_, i) =>
  Array.from({length: g.w - 6}, (_, x) => g.px[(i + 3)*g.w + x + 3] === 1 ? '#' : '.').join(''));
for(const c of ['L', 'T', 'H', 'E']){
  const g = cglyphs[c], b = bevel(interiorOf(g));
  const off = g.px.reduce((n, v, i) => n + (v !== b.px[i] ? 1 : 0), 0);
  if(off > 16) throw new Error(`the bevel rule is ${off} pixels off the real ${c}`);
}
const flipV = g => ({w: g.w, px: Array.from({length: 16}, (_, y) => g.px.slice((15 - y)*g.w, (16 - y)*g.w)).flat()});
const turn  = g => { const px = new Array(256).fill(0);              // a quarter turn, clockwise
  for(let y = 0; y < 16; y++) for(let x = 0; x < 16; x++) px[x*16 + 15 - y] = g.px[y*g.w + x]; return {w: 16, px}; };
const RANK = [0, 7, 1, 4, 3, 5, 6];                                    // stronger wins when two overlap: interior, rim, ramp, outline
const over = (a, b) => ({w: a.w, px: a.px.map((v, i) => (RANK[b.px[i]] || 0) > (RANK[v] || 0) ? b.px[i] : v)});
const derived = {
  W: flipV(cglyphs.M),                                                 // M upside down
  Z: turn(cglyphs.N),                                                  // N on its side
  Q: over(cglyphs.O, bevel(['..........', '..........', '..........', '..........', '..........',
                              '..........', '.....##...', '......##..', '.......###', '........##'])),
  V: bevel(['###....###', '###....###', '.###..###.', '.###..###.', '..######..', '..######..', '...####...', '...####...', '....##....', '....##....']),
  0: cglyphs.O,
  1: bevel(['.####', '#####', '#####', '.####', '.####', '.####', '.####', '.####', '.####', '.####']),
  3: bevel(['########.', '......###', '......###', '..######.', '..######.', '......###', '......###', '......###', '########.', '########.']),
  4: bevel(['....####.', '...#####.', '..##.###.', '.##..###.', '##...###.', '#########', '#########', '.....###.', '.....###.', '.....###.']),
  5: bevel(['#########', '###......', '###......', '#######..', '########.', '......###', '......###', '......###', '########.', '#######..']),
  6: bevel(['.#######.', '###......', '###......', '########.', '#########', '###...###', '###...###', '###...###', '#########', '.#######.']),
  7: bevel(['#########', '......###', '.....###.', '....###..', '...###...', '...###...', '..###....', '..###....', '..###....', '..###....']),
  8: bevel(['.#######.', '###...###', '###...###', '.#######.', '#########', '###...###', '###...###', '###...###', '#########', '.#######.']),
  '&': bevel(['..####...', '.##..##..', '.##..##..', '..####...', '.#####.##', '##..####.', '##...###.', '##...###.', '.#######.', '..###..##']),
  '.': bevel(['....', '....', '....', '....', '....', '....', '....', '....', '####', '####']),
  ',': bevel(['....', '....', '....', '....', '....', '....', '....', '####', '####', '..##']),
  '!': bevel(['####', '####', '####', '####', '####', '####', '....', '....', '####', '####']),
  '?': bevel(['#######.', '......##', '......##', '...####.', '...###..', '...###..', '........', '........', '...###..', '...###..']),
  "'": bevel(['####', '####', '####', '....', '....', '....', '....', '....', '....', '....']),
  '-': bevel(['......', '......', '......', '......', '######', '######', '......', '......', '......', '......']),
  ':': bevel(['####', '####', '....', '....', '....', '....', '....', '....', '####', '####']),
};
derived[9] = {w: derived[6].w, px: derived[6].px.slice().reverse()};    // 6 turned round
for(const [c, g] of Object.entries(derived)) if(!cglyphs[c]) cglyphs[c] = {...g, from: 'derived'};

const corder = Object.keys(cglyphs).sort();
const CW = corder.reduce((a, c) => a + cglyphs[c].w + 2, 0), catlas = new Uint8Array(CW * 16);
const ctable = {rowh: 16, glyphs: {}};
let cx = 0;
for(const c of corder){
  const g = cglyphs[c];
  for(let y = 0; y < 16; y++) for(let x = 0; x < g.w; x++) catlas[y*CW + cx + x] = g.px[y*g.w + x];
  ctable.glyphs[c] = [cx, 0, g.w, 16, 0];
  cx += g.w + 2;
}
// palid_Sonic's line 0, which the credits are drawn in
const credPal = words(rd('S1_Pal_Sonic.bin')).slice(0, 16).map(rgb);
fs.writeFileSync(OUT + 'cred-atlas.png', encodeIndexedPng(catlas, CW, 16, credPal, 0));
fs.writeFileSync(OUT + 'cred-table.json', JSON.stringify(ctable));
console.log(`cred-atlas.png   ${CW}x16  ${corder.length} glyphs (${corder.filter(c => cglyphs[c].from === 'derived').join('')} derived)`);

// ---- the Sonic 1 title card ----------------------------------------------------------------
// Object $34 over Nem_TitleCard, palette line 0 (Sonic's), high priority. Its letters are
// read off Map_Card's commented pieces like the credits: 16px apart, I 8 wide, a 16px gap
// between words. The art also holds a K, a U and a full stop no card ever spells; they are
// the game's, so they are used.
const cardArt = nemDecode(rd('S1_TitleCards.nem'));
const cardMapText = rd('S1_TitleCards_map.asm').toString();
const cardFrames = parseS1MapFrames(cardMapText);
const kfound = {};
for(const m of cardMapText.matchAll(/spritePiece\s+([^;\n]+);\s*([A-Z])\s*$/gm)){
  const f = m[1].split(',').map(s => s.trim());
  (kfound[m[2]] ??= new Set()).add([f[2], f[3], f[4]].join(','));
}
Object.assign(kfound, {K: new Set(['2,2,$22']), U: new Set(['2,2,$46']), '.': new Set(['1,1,$52'])});
const kglyphs = {};
for(const [ch, keys] of Object.entries(kfound)){
  if(keys.size > 1) throw new Error(`title card ${ch} has ${keys.size} tile sets`);
  const [w, h, t] = [...keys][0].split(',').map(v => v.startsWith('$') ? parseInt(v.slice(1), 16) : +v);
  let r = renderFrame([[0, ((w-1) << 2) | (h-1), t >> 8, t & 0xFF, 0, 0]], cardArt);
  if(ch === '.'){                                              // a 1x1 piece: sit it on the baseline
    const px = new Uint8Array(8*16); px.set(r.px.subarray(0, 64), 8*8); r = {w: 8, px};
  }
  kglyphs[ch] = {w: r.w, px: Array.from(r.px, v => v & 15), from: 'title card'};
}
console.log(`  S1 card: ${Object.keys(kglyphs).sort().join('')} decoded`);

// White face (6) anti-aliased with greys (7, 8), and a black shadow (1) cast down and to the
// right: the shadow is wherever the face is one pixel up or one left. That lands on 86% of
// the real letters' shadow pixels -- the artist rounded some by hand -- which is close enough
// to re-shadow a derived glyph, after its old shadow is taken off.
const FACE = v => v === 6 || v === 7 || v === 8;
const faceOf = g => ({w: g.w, px: g.px.map(v => FACE(v) ? v : 0)});
const shadow = g => ({w: g.w, px: g.px.map((v, i) => {
  if(v) return v;
  const x = i % g.w, y = (i / g.w) | 0;
  return (x > 0 && FACE(g.px[i - 1])) || (y > 0 && FACE(g.px[i - g.w])) ? 1 : 0;
})});
const vflip = g => ({w: g.w, px: Array.from({length: 16}, (_, y) => g.px.slice((15 - y)*g.w, (16 - y)*g.w)).flat()});
const rowsOf = g => Array.from({length: 16}, (_, y) => g.px.slice(y*g.w, (y + 1)*g.w));
const fromRows = rows => ({w: rows[0].length, px: rows.flat()});
// faces drawn with the title-card primitives' sampling, cut into the face and its two greys
function face(w, ...parts){
  const px = new Array(w*16).fill(0);
  for(let y = 0; y < 16; y++) for(let x = 0; x < w; x++){
    let c = 0;
    for(let sy = 0; sy < 8; sy++) for(let sx = 0; sx < 8; sx++)
      if(parts.some(f => f(x + (sx + 0.5)/8, y + (sy + 0.5)/8))) c += 1/64;
    px[y*w + x] = c >= 0.75 ? 6 : c >= 0.45 ? 7 : c >= 0.2 ? 8 : 0;
  }
  return {w, px};
}
const kseg = (x0, y0, x1, y1, hw = 1.1) => (X, Y) => {
  const dx = x1 - x0, dy = y1 - y0, t = Math.max(0, Math.min(1, ((X-x0)*dx + (Y-y0)*dy) / (dx*dx + dy*dy)));
  return Math.hypot(X - (x0 + t*dx), Y - (y0 + t*dy)) <= hw;
};
const karc = (cx, cy, rx, ry, a0, a1, hw = 1.1) => (X, Y) => {
  const nx = (X - cx)/rx, ny = (Y - cy)/ry, t = Math.atan2(ny, nx);
  let deg = t * 180 / Math.PI; if(deg < 0) deg += 360;
  if(a0 <= a1 ? deg < a0 || deg > a1 : deg < a0 && deg > a1) return false;
  return Math.abs(Math.hypot(nx, ny) - 1) * Math.hypot(rx*Math.cos(t), ry*Math.sin(t)) <= hw;
};
const kbox = (x0, y0, x1, y1) => (X, Y) => X >= x0 && X < x1 && Y >= y0 && Y < y1;
const overlay = (a, b) => ({w: a.w, px: a.px.map((v, i) => Math.max(v ? 9 - v : 0, b.px[i] ? 9 - b.px[i] : 0)).map(r => r ? 9 - r : 0)});
{
  const A = rowsOf(faceOf(kglyphs.A)), bar = A.findIndex(r => r.filter(v => v).length >= 9);
  const V = vflip(fromRows(A.map((r, y) => y === bar ? r.map((v, x) => (x > 2 && x < 10) ? 0 : v) : r)));
  const Y = rowsOf(faceOf(kglyphs.Y)).slice(0, 8);
  const U = rowsOf(faceOf(kglyphs.U));
  const kd = {
    V: shadow(V),                                                    // A turned over, its bar taken out
    W: shadow(vflip(faceOf(kglyphs.M))),                             // M turned over
    X: shadow(fromRows([...Y, ...Y.slice().reverse()])),             // Y's open top, and again below
    J: shadow(fromRows(U.map((r, y) => y < 11 ? r.map((v, x) => x < 5 ? 0 : v) : r))),   // U, left stem cut
    Q: shadow(overlay(faceOf(kglyphs.O), face(16, kseg(9.5, 11.5, 14.5, 15.5)))),        // O and a tail
    0: kglyphs.O,
    1: shadow(face(10, kbox(4, 0, 7, 15), kseg(1.5, 3.5, 5, 0.8), kbox(2, 14, 9, 15))),
    2: shadow(face(14, karc(6.5, 4.2, 4.5, 3.8, 180, 50), kseg(10, 6.8, 2, 14.2), kbox(1.5, 13.5, 12, 15))),
    3: shadow(face(14, karc(6.4, 3.8, 4.4, 3.2, 200, 90), karc(6.6, 10.6, 5.0, 4.0, 270, 160))),
    4: shadow(face(14, kbox(8.5, 0, 11.5, 15), kseg(9.5, 0.8, 1.8, 10.2), kbox(1, 9.6, 13, 11.4))),
    5: shadow(face(14, kbox(2, 0, 11.5, 2), kbox(2, 0, 4.5, 6.6), karc(6.4, 10.2, 5.2, 4.4, 230, 150))),
    6: shadow(face(14, karc(6.6, 10.6, 4.8, 4.0, 0, 360), karc(10.4, 10.6, 8.6, 9.8, 180, 270))),
    7: shadow(face(14, kbox(1.5, 0, 12.5, 2), kseg(11.6, 1.5, 5, 15))),
    8: shadow(face(14, karc(6.6, 3.6, 3.8, 3.0, 0, 360), karc(6.6, 10.6, 5.0, 4.0, 0, 360))),
    '!': shadow(face(6, kbox(2, 0, 4.5, 10.5), kbox(2, 13, 4.5, 15))),
    '?': shadow(face(13, karc(6, 4, 4.4, 3.6, 180, 100), kbox(5, 7.5, 7.5, 10.5), kbox(5, 13, 7.5, 15))),
    "'": shadow(face(6, kbox(2, 0, 4.5, 5))),
    ',': shadow(face(6, kbox(2, 12, 4.5, 14.5), kseg(4, 14, 2.4, 15.8, 0.9))),
    '-': shadow(face(10, kbox(1, 7, 8, 9))),
    ':': shadow(face(6, kbox(2, 4, 4.5, 6.5), kbox(2, 12.5, 4.5, 15))),
    '&': shadow(face(15, karc(6, 3.6, 3.2, 3.0, 0, 360), kseg(7.6, 6.2, 13.5, 15), karc(6, 10.8, 4.4, 4.0, 330, 215),
                     kseg(4, 6.4, 2.4, 8.4), kseg(11, 9, 13.6, 7.4))),
  };
  kd[9] = {w: kd[6].w, px: kd[6].px.slice().reverse()};             // 6 turned round
  kd[9] = shadow(faceOf({w: kd[9].w, px: kd[9].px.map(v => v === 1 ? 0 : v)}));
  for(const [c, g] of Object.entries(kd)) if(!kglyphs[c]) kglyphs[c] = {...g, from: 'derived'};
}
const korder = Object.keys(kglyphs).sort();
const KW = korder.reduce((a, c) => a + kglyphs[c].w + 2, 0), katlas = new Uint8Array(KW * 16);
const ktable = {rowh: 16, space: 16, glyphs: {}, parts: {}};
let kx = 0;
for(const c of korder){
  const g = kglyphs[c];
  for(let y = 0; y < 16; y++) for(let x = 0; x < g.w; x++) katlas[y*KW + kx + x] = g.px[y*g.w + x];
  ktable.glyphs[c] = [kx, 0, g.w, 16, 0];
  kx += g.w + 2;
}
const sonicPal = words(rd('S1_Pal_Sonic.bin')).slice(0, 16).map(rgb);
fs.writeFileSync(OUT + 's1card-atlas.png', encodeIndexedPng(katlas, KW, 16, sonicPal, 0));
// ZONE (frame 6), ACT 1-3 (7-9), the blue oval ($A), each with its offset from its origin
for(const [name, f] of [['zone', 6], ['act1', 7], ['act2', 8], ['act3', 9], ['oval', 10]]){
  const r = renderFrame(cardFrames[f], cardArt);
  for(let i = 0; i < r.px.length; i++) r.px[i] &= 15;
  fs.writeFileSync(OUT + `s1card-${name}.png`, encodeIndexedPng(r.px, r.w, r.h, sonicPal, 0));
  ktable.parts[name] = {ox: r.ox, oy: r.oy, w: r.w, h: r.h};
}
// Card_ItemData and Card_ConData, in screen coordinates. Names are centred on their origin,
// which slides in from the left to x 160; across every zone ZONE rests at 160 + half the
// name's width - 48, ACT and the oval 24 further right. ZONE starts $240 left of its rest,
// ACT $2C0 right, the oval $C0 right. In at $10 a frame; once the act lands the level loads
// and fades in under the static card (4 + 22 frames), Card_Wait holds 60 more, then all four
// head back at $20 a frame. Each is drawn only while its origin is within VDP x 0-$1FF.
ktable.card = {
  name: {y: 0xD0 - 0x80, from: -0x80, to: 0x120 - 0x80},
  zone: {y: 0xE4 - 0x80, rel: -48, start: -0x240},
  act:  {y: 0xEA - 0x80, rel: -24, start: 0x2C0},
  oval: {y: 0xE0 - 0x80, rel: -24, start: 0xC0},
  speedIn: 0x10, speedOut: 0x20, frozen: 4 + 22, wait: 60, minX: -0x80, maxX: 0x200 - 0x80,
};
fs.writeFileSync(OUT + 's1card-table.json', JSON.stringify(ktable));
console.log(`s1card-atlas.png ${KW}x16  ${korder.length} glyphs (${korder.filter(c => kglyphs[c].from === 'derived').join('')} derived)`);

// ---- Green Hill Zone, act 1, as it opens ---------------------------------------------------
// Where the Sonic 1 title card lands: GHZ1 at its start position. LevelSizeLoad puts the
// camera at (0, $300) for Sonic's start at ($50, $3B0); the only object in that first screen
// is Sonic -- the nearest rings start at x $144, just off the right edge. Plane B is the same
// GHZ background the title draws (BG V-scroll comes out 8 here too), so s1-bg.png serves.
{
  const tiles2 = new Uint8Array((0x1CD + 369)*32);
  tiles2.set(tiles, 0); tiles2.set(nemDecode(rd('S1_GHZ2.nem')), 0x1CD*32);   // Nem_GHZ_2nd at $1CD
  const fgLay = rd('S1_GHZ1_FG.bin'), fw = fgLay[0] + 1, fh = fgLay[1] + 1;
  const CAM_X = 0, CAM_Y = 0x300;
  const lo = new Uint8Array(W*H), hi = new Uint8Array(W*H);
  for(let y = 0; y < H; y++) for(let x = 0; x < W; x++){
    const X = x + CAM_X, Y = y + CAM_Y, row = Y >> 8, col = X >> 8;
    if(row >= fh || col >= fw) continue;
    const id = fgLay[2 + row*fw + col] & 0x7F; if(!id) continue;
    const cw = chunks.readUInt16BE((id - 1)*0x200 + ((Y >> 4) & 15)*32 + ((X >> 4) & 15)*2);
    let qx = (X >> 3) & 1, qy = (Y >> 3) & 1;
    if(cw & 0x800) qx ^= 1; if(cw & 0x1000) qy ^= 1;
    let w = blocks[(cw & 0x3FF)*4 + qy*2 + qx];
    if(cw & 0x800) w ^= 0x800; if(cw & 0x1000) w ^= 0x1000;
    const t = w & 0x7FF, sx = w & 0x800 ? 7 - (X & 7) : X & 7, sy = w & 0x1000 ? 7 - (Y & 7) : Y & 7;
    const b = tiles2[t*32 + sy*4 + (sx >> 1)], c = sx & 1 ? b & 15 : b >> 4;
    if(c) (w & 0x8000 ? hi : lo)[y*W + x] = ((w >> 13) & 3)*16 + c;
  }
  writeIdx('ghz-fg.png', lo, W, H);
  writeIdx('ghz-fg-hi.png', hi, W, H);
  // Sonic standing: MS_Stand, whose DPLC loads Sonic.unc tiles 0-16 in order, so the
  // mapping's tiles index the art directly. Palette line 0. SonAni_Wait holds this frame
  // for 288 frames, longer than anything here runs.
  const stand = parseS1MapFrames(rd('S1_Sonic_map.asm').toString())[1];
  const r = renderFrame(stand, rd('S1_Sonic.unc'));
  writeIdx('ghz-sonic.png', r.px, r.w, r.h);
  // Palette: Sonic's line 0, Pal_GHZ in lines 1-3. Lines 1-3 fade in by PalFadeIn_Alt --
  // the same step as the title's, but line 0 stays lit -- then PalCycle_GHZ rotates line 2
  // colours 8-11 every 6 frames.
  const sonic = words(rd('S1_Pal_Sonic.bin')).slice(0, 16), ghz = words(rd('S1_Pal_GHZ.bin'));
  const cyc = words(rd('S1_Pal_GHZCycle.bin'));
  if(ghz.length !== 48 || cyc.length !== 16) throw new Error('unexpected GHZ palette sizes');
  const full = [...sonic, ...ghz], gp = [];
  let c = [...sonic, ...new Array(48).fill(0)];
  for(let s = 0; s < 22; s++){
    gp.push(hex(c));
    c = c.map((v, i) => { if(i < 16) return v; const t = full[i];
      return v === t ? v : v + 0x200 <= t ? v + 0x200 : v + 0x20 <= t ? v + 0x20 : v + 2; });
  }
  if(hex(c) !== hex(full)) throw new Error('the GHZ fade does not land on its palette');
  for(let k = 0; k < 4; k++){ const p = full.slice(); for(let i = 0; i < 4; i++) p[32 + 8 + i] = cyc[k*4 + i]; gp.push(hex(p)); }
  const gmeta = {pals: gp, fadeFrames: 22, sonic: {x: 0x50 - CAM_X + r.ox, y: 0x3B0 - CAM_Y + r.oy},
                 // after the act lands: the level loads, 4 frames pass, then the 22-frame fade
                 levelDelay: 4};
  // the still: faded in, the first cycle step, Sonic standing
  const out = new Uint8Array(W*H).fill(32);
  for(let y = 0; y < H; y++){ const n = 2, s = y < 24 ? n : y < 40 ? Math.floor(0.75*n) : y < 56 ? n >> 1 : 0;
    for(let x = 0; x < W; x++){ const v = bg[y*BG_W + ((x + s) & 511)]; if(v) out[y*W + x] = v; } }
  for(let i = 0; i < W*H; i++) if(lo[i]) out[i] = lo[i];
  for(let y = 0; y < r.h; y++) for(let x = 0; x < r.w; x++){ const v = r.px[y*r.w + x]; if(v) out[(gmeta.sonic.y + y)*W + gmeta.sonic.x + x] = v; }
  for(let i = 0; i < W*H; i++) if(hi[i]) out[i] = hi[i];
  fs.writeFileSync(OUT + 'ghz-still.png', encodeIndexedPng(out, W, H, hexToPal(gp[22]), -1));
  fs.writeFileSync(OUT + 'ghz-meta.json', JSON.stringify(gmeta));
  console.log(`ghz-still.png    320x224  ${fs.statSync(OUT + 'ghz-still.png').size}B`);
}

// ---- the logo, cleared and turned into faces --------------------------------------------------
// The S1 logo style replaces SONIC and THE HEDGEHOG with the user's text, so the build
// needs the emblem without them, and their two faces.
//
// Clearing: the ribbon behind the letters is a flag -- red, a white stripe on rows 86-100,
// red -- read off the gap between I and C, which is pure ribbon. Between x 59 and 196 the
// letters cover nothing else, so rows 76-115 are refilled from that pattern. Either side,
// S and C touch the ribbon's star-field ends, which are mirror images of each other about
// x 127.5 and the letters are not: rows above 89 have no star field, so those are refilled
// too; below, a pixel that matches its mirror is star field, black is always letter, and
// one side showing ribbon where the other does not is letter over ribbon.
{
  const EWD = EW*8, ribbon = y => y >= 86 && y <= 100 ? 6 : 12;
  const clean = Uint8Array.from(emblem);
  const MIR = x => 255 - x;
  for(let y = 76; y <= 115; y++){
    for(let x = 59; x <= 196; x++) clean[y*EWD + x] = ribbon(y);
    for(let x = 52; x <= 58; x++){
      const a = emblem[y*EWD + x], b = emblem[y*EWD + MIR(x)], rb = ribbon(y);
      if(y < 89){ clean[y*EWD + x] = clean[y*EWD + MIR(x)] = rb; continue; }
      if(a === b && (a & 15) !== 15) continue;
      if((a & 15) === 15 || b === rb) clean[y*EWD + x] = rb;
      if((b & 15) === 15 || a === rb) clean[y*EWD + MIR(x)] = rb;
      if(a !== b && a !== rb && b !== rb && (a & 15) !== 15 && (b & 15) !== 15) clean[y*EWD + x] = clean[y*EWD + MIR(x)] = rb;
    }
  }
  writeIdx('s1-emblem-clean.png', clean, EWD, EH*8);

  // The chrome face. S O N I C are lifted as shapes: their fill colours (the blues and
  // golds), plus white with fill above it in the column -- the band through the middle and
  // the rim along the bottom -- leaving out the white caps and the black. Stray pixels of
  // the star field that share the fill colours are kept out by column and row.
  const FILL = new Set([3, 4, 5, 11, 9, 8, 7]);
  const LIFT = {S: [56, 84], O: [84, 117], N: [117, 150], I: [154, 169], C: [169, 199]};
  const shapes = {...DESIGNS};
  for(const [k, [a, b]] of Object.entries(LIFT)){
    const m = new Set();
    for(let x = a; x < b; x++){ let f = false;
      for(let y = 76; y <= 103; y++){
        if((x < 59 || x > 196) && y >= 89) continue;
        const v = emblem[y*EWD + x] & 15;
        if(FILL.has(v)){ f = true; m.add(x*1000 + y); } else if(v === 6 && f) m.add(x*1000 + y); else if(v === 15) f = false;
      } }
    // drop specks: pixels with fewer than two of their four neighbours in the shape
    for(const v of [...m]){ const x = Math.floor(v/1000), y = v % 1000;
      if([[1,0],[-1,0],[0,1],[0,-1]].filter(([dx, dy]) => m.has((x+dx)*1000 + y+dy)).length < 2) m.delete(v); }
    const xs = [...m].map(v => Math.floor(v/1000)), x0 = Math.min(...xs), x1 = Math.max(...xs);
    shapes[k] = Array.from({length: 26}, (_, i) => Array.from({length: x1 - x0 + 1}, (_, j) => m.has((x0 + j)*1000 + 77 + i) ? '#' : '.').join(''));
  }
  // the fill by row, read down the I, which is straight-sided top to bottom
  const gradient = Array.from({length: 26}, (_, i) => emblem[(77 + i)*EWD + 160] & 15);
  // The small face: T H E D G O lifted from rows 108-113 (white), the rest designed.
  const small = {...SMALL}, words = ['T', 'H', 'E', null, 'H', 'E', 'D', 'G', 'E', 'H', 'O', 'G'];
  let col = 86, k = 0;
  while(col < 170 && k < words.length){
    while(col < 170 && ![...Array(6)].some((_, i) => (emblem[(108 + i)*EWD + col] & 15) === 6)) col++;
    const s = col; while([...Array(6)].some((_, i) => (emblem[(108 + i)*EWD + col] & 15) === 6)) col++;
    if(words[k] === null) k++;
    const ch = words[k++];
    if(ch && !small[ch]) small[ch] = Array.from({length: 6}, (_, i) =>
      Array.from({length: col - s}, (_, j) => (emblem[(108 + i)*EWD + s + j] & 15) === 6 ? '#' : '.').join(''));
  }
  for(const c of 'THEDGO') if(!small[c]) throw new Error('small ' + c + ' was not lifted');
  // Placement, in screen coordinates (the emblem sits at 24, 32): SONIC's shapes start on
  // emblem row 77, THE HEDGEHOG's on 108; both centred on the emblem's middle, x 127.5.
  const logo = {chrome: shapes, gradient, small, top: 77 + EY, smallTop: 108 + EY, cx: 128 + EX,
                gap: 3, space: 12, smallGap: 1, smallSpace: 7, depth: 3, spread: 16, lean: 3};
  fs.writeFileSync(OUT + 's1-logo.json', JSON.stringify(logo));
  console.log(`  logo: ${Object.keys(shapes).length} chrome shapes (SONIC lifted), ${Object.keys(small).length} small`);
}
