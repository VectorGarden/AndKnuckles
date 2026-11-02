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
