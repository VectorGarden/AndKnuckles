/* Builds the Sonic 2 title screen.
   Run it with:  node tools/build-s2-assets.mjs [outDir]

   From sonicretro/s2disasm (REV01, bugs kept -- it is the game people played):

     s2-bg.png        plane B: MapEng_TitleScreen and MapEng_TitleBack side by
                      side, the 512px plane TitleScreen fills
     s2-emblem.png    plane A: MapEng_TitleLogo, with the copyright line
     s2-spr*.png      Obj0E's mapping frames, as palette-index layers
     s2-still.png     the title at rest, for still mode
     s2-meta.json     palettes, and Obj0E's timeline: every frame's sprites

   And the credit font -- SONIC AND MILES 'TAILS' PROWER IN, the staff roll --
   as a letter style: s2cred-atlas.png and s2cred-table.json.

   Nothing on this screen is a fixed picture. It opens on black with a star
   twinkling from place to place, the emblem fades in, Sonic and then Tails rise
   out of it, and the background arrives in a white flash. All of that is one
   object, Obj0E, plus two palette changers (ObjC9), so the build runs them --
   transcribed from s2.asm below -- and writes down what each frame shows. The
   page only plays that table back. */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {eniDecode} from './lib/enigma.mjs';
import {nemDecode} from './lib/nemesis.mjs';
import {kosDecode} from './lib/kosinski.mjs';
import {encodeIndexedPng} from './lib/png.mjs';
import {parseS1MapFrames, parseMacroDplcFrames, renderFrame} from './lib/sprite.mjs';
import {DESIGNS, SMALL, SONIC} from './font/s1-logo.mjs';

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

// ---- VRAM, loaded in TitleScreen's order -------------------------------------------------
// The credit font goes in first, for the text before the title, then the title's own art
// over and around it. Tile numbers below are absolute, as the name tables hold them.
const vram = new Uint8Array(0x800 * 32);
for(const [file, tile] of [['S2_CreditText.nem', 0x500], ['S2_Title.nem', 0x000], ['S2_TitleSprites.nem', 0x150],
                           ['S2_MenuJunk.nem', 0x3F2], ['S2_Player1VS2.nem', 0x402], ['S2_FontStuff.nem', 0x680]]){
  const t = nemDecode(rd(file));
  vram.set(t, tile * 32);
}
function tile(px, pw, w, X, Y){                       // one name-table word into px (line*16 + colour)
  const t = w & 0x7FF, L = (w >> 13) & 3, hf = w & 0x800, vf = w & 0x1000;
  for(let y = 0; y < 8; y++) for(let x = 0; x < 8; x++){
    const sx = hf ? 7 - x : x, sy = vf ? 7 - y : y, b = vram[t*32 + sy*4 + (sx >> 1)];
    const c = (sx & 1) ? b & 15 : b >> 4;
    if(c) px[(Y + y)*pw + X + x] = L*16 + c;
  }
}

// ---- plane B ------------------------------------------------------------------------------
// TitleScreen writes the 40x28 MapEng_TitleScreen at cell (0,0) and the 24x28 MapEng_TitleBack
// at cell (40,0) of a 64-cell plane, both on palette line 2, low priority. Nothing redraws it.
const BG_W = 512;
const bg = new Uint8Array(BG_W * H);
{
  const a = eniDecode(rd('S2_TitleScreen.eni'), 0x4000), b = eniDecode(rd('S2_TitleBack.eni'), 0x4000);
  if(a.length !== 40*28 || b.length !== 24*28) throw new Error('unexpected title plane-B map sizes');
  for(let r = 0; r < 28; r++){
    for(let c = 0; c < 40; c++) tile(bg, BG_W, a[r*40 + c], c*8, r*8);
    for(let c = 0; c < 24; c++) tile(bg, BG_W, b[r*24 + c], (40 + c)*8, r*8);
  }
  if([...a, ...b].some(w => w & 0x8000)) throw new Error('a plane-B tile is high priority');
}
writeIdx('s2-bg.png', bg, BG_W, H);

// ---- plane A: the emblem, and the copyright line -------------------------------------------
// MapEng_TitleLogo on line 3, high priority, then CopyrightText over cell (28,26): the menu
// font's tiles from $680 in the charset s2.asm sets up for it -- digits from 0, @ (the (C)
// sign) $B, letters from $E -- on line 0 and low priority. A space is tile 0.
const emblem = new Uint8Array(W * H);
const COPYRIGHT = '@ 1992 SEGA';
{
  const m = eniDecode(rd('S2_TitleLogo.eni'), 0xE000);
  if(m.length !== 40*28) throw new Error('unexpected emblem map size');
  const code = c => c === ' ' ? 0 : 0x680 + (c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : c === '@' ? 0xB : c.charCodeAt(0) - 65 + 0xE);
  [...COPYRIGHT].forEach((c, i) => { m[26*40 + 28 + i] = code(c); });
  for(let r = 0; r < 28; r++) for(let c = 0; c < 40; c++) tile(emblem, W, m[r*40 + c], c*8, r*8);
}
writeIdx('s2-emblem.png', emblem, W, H);

// ---- Obj0E's mapping frames -------------------------------------------------------------------
// art_tile is make_art_tile(ArtTile_ArtNem_TitleSprites, 0, 0) for all of them, except the
// masking sprite's ($11), which is tile 0 and draws nothing -- the page models it as the band
// of lines it masks. Pieces in one frame can differ in priority (the emblem top, $A/$B), so each
// frame is split into a high and a low layer.
const frames = parseS1MapFrames(rd('S2_TitleSprites_map.asm').toString());
if(frames.length !== 0x14) throw new Error('expected 20 Obj0E mapping frames');
const sprites = [];                                 // [frame][hi] -> {ox, oy, w, h} or null
function renderPieces(pieces){
  if(!pieces.length) return null;
  const box = pieces.map(([yy, size, , , xh, xl]) => {
    let Y = yy > 127 ? yy - 256 : yy, X = (xh << 8) | xl; if(X > 32767) X -= 65536;
    return {X, Y, pw: ((size >> 2) & 3) + 1, ph: (size & 3) + 1};
  });
  const ox = Math.min(...box.map(b => b.X)), oy = Math.min(...box.map(b => b.Y));
  const w = Math.max(...box.map(b => b.X + b.pw*8)) - ox, h = Math.max(...box.map(b => b.Y + b.ph*8)) - oy;
  const px = new Uint8Array(w*h), mine = new Uint8Array(w*h);
  pieces.forEach(([, , th, tl], i) => {
    const {X, Y, pw, ph} = box[i], word = (th << 8) | tl;
    let t = 0x150 + (word & 0x7FF);
    const hf = word & 0x800, vf = word & 0x1000, L = (word >> 13) & 3;
    for(let cx = 0; cx < pw; cx++) for(let cy = 0; cy < ph; cy++, t++){
      for(let y = 0; y < 8; y++) for(let x = 0; x < 8; x++){
        const sx = hf ? 7 - x : x, sy = vf ? 7 - y : y, b = vram[t*32 + sy*4 + (sx >> 1)];
        const c = (sx & 1) ? b & 15 : b >> 4;
        const gx = X - ox + (hf ? pw - 1 - cx : cx)*8 + x, gy = Y - oy + (vf ? ph - 1 - cy : cy)*8 + y;
        if(!c || mine[gy*w + gx]) continue;          // the first piece wins, as on the VDP
        mine[gy*w + gx] = 1; px[gy*w + gx] = L*16 + c;
      }
    }
  });
  if(!px.some(v => v)) return null;
  return {px, w, h, ox, oy};
}
let nspr = 0;
frames.forEach((f, i) => {
  sprites[i] = [null, null];
  if(i === 0x11) return;                             // the mask
  for(const hi of [0, 1]){
    const r = renderPieces(f.filter(p => (p[2] >> 7) === hi));
    if(!r) continue;
    const file = `s2-spr${nspr}.png`;
    writeIdx(file, r.px, r.w, r.h);
    sprites[i][hi] = {ox: r.ox, oy: r.oy, w: r.w, h: r.h, file, px: r.px, n: nspr++};
  }
});

// ---- palettes -----------------------------------------------------------------------------------
const P = {title: words(rd('S2_Pal_Title.bin')), sonic: words(rd('S2_Pal_TitleSonic.bin')),
           back: words(rd('S2_Pal_TitleBackground.bin')), emblem: words(rd('S2_Pal_TitleEmblem.bin')),
           star: words(rd('S2_Pal_TitleStarCycle.bin'))};
if(P.star.length !== 6 || ['title', 'sonic', 'back', 'emblem'].some(k => P[k].length !== 16))
  throw new Error('unexpected S2 palette sizes');
// Pal_FadeFromBlack.UpdateColour: +$200 (blue) if it does not pass the target as a word,
// else +$20, else +2.
const fadeUp = (c, t) => c === t ? c : c + 0x200 <= t ? c + 0x200 : c + 0x20 <= t ? c + 0x20 : c + 2;
// loc_1344C: each channel down by one step while it is above the target's.
const fadeDown = (c, t) => {
  let b = (c >> 9) & 7, g = (c >> 5) & 7, r = (c >> 1) & 7;
  if(b > ((t >> 9) & 7)) b--; if(g > ((t >> 5) & 7)) g--; if(r > ((t >> 1) & 7)) r--;
  return (b << 9) | (g << 5) | (r << 1);
};

// ---- Obj0E and ObjC9, run frame by frame --------------------------------------------------------
// Positions are the objects' own: x_pixel/y_pixel, 128 + screen. spriteScreenPositionXCentered(x)
// is 128+160+x; ...YCentered(y) is 128+112+y.
const CX = x => 288 + x, CY = y => 240 + y;
const POS = {
  sonic: [[-24, -32], [-32, -48], [-40, -64], [-42, -74], [-38, -82], [-32, -86], [-28, -87], [-24, -88]],
  tails: [[-73, -40], [-77, -56], [-82, -68], [-84, -74], [-86, -78], [-87, -79], [-88, -80]],
  star:  [[-70, 2], [80, 8], [18, 65], [126, -78], [-96, -13], [96, -16], [-19, 75], [-96, -69], [69, 23]],
  sonicHand: [[35, -47], [32, -46], [33, -47]],
  tailsHand: [[-20, -32], [-19, -31]],
};
// Ani_obj0E: [duration, frames..., end code]. REV01's Sonic script still has frame 8, the
// prototype frame with both arms missing, for a frame.
const ANI = [[1, 5, 6, 7, 8, 0xFA], [1, 0, 1, 2, 3, 4, 0xFA], [1, 0xC, 0xD, 0xE, 0xD, 0xC, 0xFA], [3, 0xC, 0xF, 0xFF]];
// Object RAM, as s2.constants.asm lays the title screen out: the slot order is the order
// RunObjects runs them and DisplaySprite queues them.
const SLOT = {sonic: 1, tails: 2, star: 3, palChanger3: 4, emblemTop: 5, mask: 6, sonicHand: 7, tailsHand: 8,
              palChanger2: 9, fallingStar: 17};
const objs = [], lists = Array.from({length: 8}, () => []);
const normal = new Array(64).fill(0), target = new Array(64).fill(0);
let vint = 0;
// Obj0E_Init gives every one priority 4 before handing over to its subtype.
const spawn = (slot, o) => { objs[slot] = {sec: 0, frame: 0, x: 0, y: 0, pri: 4, hi: 0, anim: 0, prevAnim: 0,
                                           animFrame: 0, animDur: 0, counter: 0, idx: 0, cf: 0, ...o}; };
const display = o => lists[o.pri].push(o);
function animate(o){                                 // AnimateSprite, for the codes Obj0E uses
  if(o.anim !== o.prevAnim){ o.prevAnim = o.anim; o.animFrame = 0; o.animDur = 0; }
  if(--o.animDur >= 0) return;
  const s = ANI[o.anim];
  o.animDur = s[0];
  let c = s[1 + o.animFrame];
  if(c === 0xFA){ o.sec += 2; return; }
  if(c === 0xFF){ o.animFrame = 0; c = s[1]; }
  o.frame = c & 0x7F; o.animFrame++;
}
function move(o, pos){                               // Obj0E_Move: the next position every 4 frames
  if((++o.counter & 3) === 0){
    const i = o.idx + 4;
    if(i >= pos.length*4 + 4){ o.sec += 2; display(o); return; }
    o.idx = i; o.x = CX(pos[i/4 - 1][0]); o.y = CY(pos[i/4 - 1][1]);
  }
  display(o);
}
const RUN = {
  sonic(o){
    o.cf++;
    switch(o.sec){
      case 0: o.sec = 2; o.frame = 5; o.x = CX(-16); o.y = CY(-16);
        spawn(SLOT.star, {kind: 'star'}); spawn(SLOT.emblemTop, {kind: 'emblemTop'}); return;
      case 2: if(o.cf < 56) return;
        o.sec = 4; spawn(SLOT.palChanger3, {kind: 'pal', data: P.emblem, off: 48, time: 2, amount: 0x15, fn: fadeUp}); return;
      case 4: if(o.cf < 128) return;
        o.sec = 6; for(let i = 0; i < 16; i++) normal[i] = P.sonic[i];
        spawn(SLOT.mask, {kind: 'mask'}); return;
      case 6: return move(o, POS.sonic);
      case 8: animate(o); return display(o);
      case 0xA: o.sec = 0xC; o.frame = 0x12; spawn(SLOT.sonicHand, {kind: 'sonicHand'}); return display(o);
      case 0xC: if(o.cf >= 192){ o.sec = 0xE; spawn(SLOT.tails, {kind: 'tails'}); } return display(o);
      case 0xE: if(o.cf >= 288){
          o.sec = 0x10; o.idx = 0;
          for(let i = 32; i < 48; i++) normal[i] = 0xEEE;      // line 2 to white
          spawn(SLOT.palChanger2, {kind: 'pal', data: P.back, off: 32, time: 4, amount: 7, fn: fadeDown});
          // ...and the menu, Obj0F, which the page leaves out: the text goes there
        }
        return display(o);
      case 0x10: if(o.cf === 464){                     // NTSC timing
          spawn(SLOT.fallingStar, {kind: 'fallingStar'}); o.sec = 0x12; objs[SLOT.mask] = null;
        }
        return display(o);
      case 0x12: if((vint & 7) === 0){
          o.idx += 2; if(o.idx >= 12) o.idx = 0;
          normal[32 + 5] = P.star[o.idx >> 1];
        }
        return display(o);
    }
  },
  tails(o){
    switch(o.sec){
      case 0: o.sec = 2; o.x = CX(-72); o.y = CY(-24); o.anim = 1; return;
      case 2: return move(o, POS.tails);
      case 4: animate(o); return display(o);
      case 6: o.sec = 8; spawn(SLOT.tailsHand, {kind: 'tailsHand'}); return display(o);
      case 8: return display(o);
    }
  },
  emblemTop(o){
    // frame $B has the TM; $A, without it, is for Japanese consoles
    if(o.sec === 0){ o.frame = 0xB; o.pri = 2; o.x = CX(0); o.y = CY(-8); o.sec = 2; }
    display(o);
  },
  mask(o){
    if(o.sec === 0){ o.sec = 2; o.frame = 0x11; o.pri = 2; o.x = CX(-32); o.y = CY(0); }
    display(o);
  },
  star(o){
    switch(o.sec){
      case 0: o.sec = 2; o.frame = 0xC; o.hi = 1; o.anim = 2; o.pri = 1; o.x = CX(-32); o.y = CY(-72); o.counter = 4; return;
      case 2: animate(o); return display(o);
      case 4: if(--o.counter < 0) o.sec = 6; return;
      case 6: {
        o.sec = 2; o.animFrame = 0; o.animDur = 0; o.counter = 6;
        const i = o.idx + 4;
        if(i >= POS.star.length*4 + 4){ objs[SLOT.star] = null; return; }
        o.idx = i; o.x = CX(POS.star[i/4 - 1][0]); o.y = CY(POS.star[i/4 - 1][1]); return;
      }
    }
  },
  sonicHand(o){
    switch(o.sec){
      case 0: o.sec = 2; o.frame = 9; o.pri = 3; o.x = CX(37); o.y = CY(-49); return display(o);
      case 2: return move(o, POS.sonicHand);
      case 4: return display(o);
    }
  },
  tailsHand(o){
    switch(o.sec){
      case 0: o.sec = 2; o.frame = 0x13; o.pri = 3; o.x = CX(-17); o.y = CY(-27); return display(o);
      case 2: return move(o, POS.tailsHand);
      case 4: return display(o);
    }
  },
  fallingStar(o){
    if(o.sec === 0){ o.sec = 2; o.frame = 0xC; o.pri = 5; o.x = CX(80); o.y = CY(-112); o.anim = 3; o.counter = 140; return display(o); }
    if(--o.counter < 0){ objs[SLOT.fallingStar] = null; return; }
    o.x -= 2; o.y += 1; animate(o); display(o);
  },
  pal(o){                                            // ObjC9
    if(o.sec === 0){
      o.sec = 2; o.data.forEach((c, i) => { target[o.off + i] = c; });
      o.left = o.time; return;
    }
    if(--o.left >= 0) return;
    o.left = o.time;
    if(--o.amount < 0){ objs[objs.indexOf(o)] = null; return; }
    for(let i = 0; i < 16; i++) normal[o.off + i] = o.fn(normal[o.off + i], target[o.off + i]);
  },
};
const runObjects = () => { for(let s = 0; s < objs.length; s++){ const o = objs[s]; if(o) RUN[o.kind](o); } };
// BuildSprites: priority 0 first, each list in queue order. The first sprite is the front one.
function buildSprites(){
  const sat = [];
  for(const l of lists){ for(const o of l) sat.push(o.frame === 0x11 ? {mask: true} : {f: o.frame, x: o.x - 128, y: o.y - 128, hi: o.hi}); l.length = 0; }
  return sat;
}
spawn(SLOT.sonic, {kind: 'sonic'});

// TitleScreen: run the objects once and build sprites, then Pal_FadeFromBlack, 22 frames
// in which neither runs; then the loop. Display frame d < 22 is fade step d over the first
// build; frame 22+k shows the state after loop iteration k (22 is the state before it).
// Vint_runcount is taken as 0 when the fade starts: the real count depends on how long the
// screens before it took, and only the star's and the ripple's 8-frame phase depend on it.
runObjects();
let sat = buildSprites();
for(let i = 0; i < 16; i++) target[16 + i] = P.title[i];       // PalID_Title is one line, to line 1
const timeline = [];
const palIds = new Map(), pals = [];
const palId = p => { const h = p.map(c => c.toString(16).padStart(3, '0')).join('');
  if(!palIds.has(h)){ palIds.set(h, pals.length); pals.push(h); } return palIds.get(h); };
const ripple = [1,2,1,3,1,2,2,1,2,3,1,2,1,2,0,0, 2,0,3,2,2,3,2,2,1,3,0,0,1,0,1,3,
                1,2,1,3,1,2,2,1,2,3,1,2,1,2,0,0, 2,0,3,2,2,3,2,2,1,3,0,0,1,0,1,3, 1,2];  // SwScrl_RippleData
let camX = -0x280, layerDef = 0;
const record = scroll => timeline.push({pal: palId(normal), scroll, sat});
for(let s = 0; s < 22; s++){
  vint++;
  record(null);
  for(let i = 0; i < 64; i++) normal[i] = fadeUp(normal[i], target[i]);
}
const FRAMES = 22 + 560;                            // past the falling star, so the table holds it
let scroll = null;
while(timeline.length < FRAMES){
  vint++;
  record(scroll);
  runObjects();
  // SwScrl_Title: camera +1; BG at -camX/4 on lines 160-191, rippling on 192-207;
  // lines 0-159 and the last 16 are 0.
  camX++;
  const d2 = (-camX) >> 2;
  if((vint & 7) === 0) layerDef = (layerDef - 1) & 0xFFFF;
  scroll = {bg: d2, ripple: layerDef & 0x1F};
  sat = buildSprites();
}
// the flash: the first frame line 2 is white. Obj0E's counter counts the run before the fade
// too, so its frame 288 is loop iteration 287.
const flash = timeline.findIndex(t => pals[t.pal].slice(32*3, 33*3) === 'eee');
if(flash !== 22 + 287) throw new Error('the flash is on frame ' + flash);
const meta = {fadeFrames: 22, pals, flash, frames: FRAMES, maskTop: 112, maskBottom: 176, ripple,
              sprites: sprites.map(p => p.map(q => q && {ox: q.ox, oy: q.oy, n: q.n})),
              // per frame: palette, BG scroll (null: none yet), ripple index, then the sprite list
              // front to back as frame,x,y,hi; a bare 'm' is the masking sprite
              tl: timeline.map(t => [t.pal, t.scroll ? t.scroll.bg : null, t.scroll ? t.scroll.ripple : 0,
                                     t.sat.map(s => s.mask ? 'm' : [s.f, s.x, s.y, s.hi])])};
// The text springs in once the flash has faded: ObjC9 steps line 2 down every 5 frames, 7 times.
meta.intro = meta.flash + 40;
if(meta.tl[meta.intro][0] !== meta.tl[meta.intro - 1][0] || meta.tl[meta.intro][0] !== meta.tl[meta.intro + 60][0])
  throw new Error('the palette is still changing when the text arrives');
meta.emblem = {x: 0, y: 0};

// ---- the still: the frame the text arrives on --------------------------------------------------
// Rendered from the table the same way the page does it.
function frameRows(t){
  const e = meta.tl[t], rows = new Array(H).fill(0);
  if(e[1] === null) return rows;
  for(let y = 160; y < 192; y++) rows[y] = e[1];
  for(let y = 192; y < 208; y++) rows[y] = e[1] + ripple[e[2] + y - 192];
  return rows;
}
function compose(t){
  const e = meta.tl[t], out = new Uint8Array(W*H).fill(32), rows = frameRows(t);
  for(let y = 0; y < H; y++) for(let x = 0; x < W; x++){ const v = bg[y*BG_W + ((x - rows[y]) & 511)]; if(v) out[y*W + x] = v; }
  // a frame's low part is behind plane A unless the object's art_tile is high priority
  const draw = (s, part, masked) => {
    {
      const r = sprites[s[0]][part]; if(!r) return;
      for(let y = 0; y < r.h; y++){
        const Y = s[2] + r.oy + y; if(Y < 0 || Y >= H || (masked && Y >= meta.maskTop && Y < meta.maskBottom)) continue;
        for(let x = 0; x < r.w; x++){ const v = r.px[y*r.w + x], X = s[1] + r.ox + x; if(v && X >= 0 && X < W) out[Y*W + X] = v; }
      }
    }
  };
  const list = e[3], mi = list.indexOf('m'), lo = [], hi = [];
  list.forEach((s, i) => { if(s === 'm') return; const m = mi >= 0 && i > mi;
    (s[3] ? hi : lo).push([s, 0, m]); hi.push([s, 1, m]); });
  for(const [s, p, m] of lo.reverse()) draw(s, p, m);
  for(let i = 0; i < W*H; i++) if(emblem[i]) out[i] = emblem[i];
  for(const [s, p, m] of hi.reverse()) draw(s, p, m);
  return out;
}
{
  const t = meta.intro, pal = pals[meta.tl[t][0]];
  const out = compose(t);
  fs.writeFileSync(OUT + 's2-still.png', encodeIndexedPng(out, W, H,
    Array.from({length: 64}, (_, i) => rgb(parseInt(pal.slice(i*3, i*3 + 3), 16))), -1));
  console.log(`s2-still.png     320x224  ${fs.statSync(OUT + 's2-still.png').size}B`);
  meta.still = t;
}
// ---- the logo, cleared and turned into faces ----------------------------------------------------
// The S2 logo style replaces SONIC and THE HEDGEHOG with the user's text, as the S1 logo does: the
// same chrome lettering, the same small face, on the same kind of ribbon -- red, a white stripe --
// with star-field ends that mirror each other, here about x 159.5. Plane A colours are line 3:
// black 1, white $A, red $C.
{
  const L3 = 48, BLACK = 1, WHITE = 0xA, RED = 0xC, at = (x, y) => emblem[y*W + x] & 15, MIR = x => 319 - x;
  // The ribbon is arched: its stripe runs from row 117 to 133 at the middle and drops toward the
  // ends. Read off the columns that show nothing but ribbon, both edges fit a parabola about the
  // middle exactly; the letters' columns are refilled from it.
  const stripeTop = x => Math.round(117 + 0.00115*(x - 159.5)**2), stripeEnd = x => Math.round(133 + 0.0005*(x - 159.5)**2);
  const ribbon = (x, y) => y >= stripeTop(x) && y < stripeEnd(x) ? WHITE : RED;
  let checked = 0;
  for(let x = 84; x <= 235; x++){
    let st = -1, sb = -1, ok = true;
    for(let y = 108; y <= 139; y++){ const v = at(x, y); if(v !== RED && v !== WHITE){ ok = false; break; } if(v === WHITE){ if(st < 0) st = y; sb = y + 1; } }
    if(!ok || st < 0) continue;
    if(st !== stripeTop(x) || sb !== stripeEnd(x)) throw new Error(`the ribbon arch is off at column ${x}`);
    checked++;
  }
  if(checked < 10) throw new Error('too few ribbon columns to check the arch against');
  // Clearing rows 108-146, columns 84-235: the ribbon's curled ends and the star field reach in up to
  // column 91 from either end; there a pixel that matches its mirror is theirs, as S and C never do.
  // The glint on the 2 runs up between O and N and is kept.
  const clean = Uint8Array.from(emblem);
  const glint = (x, y) => [7, 8].includes(at(x, y)) && x >= 148 && x <= 172 && y >= 133 && y <= 147 && (y >= 134 || x < 153);
  for(let y = 108; y <= 146; y++) for(let x = 84; x <= 235; x++){
    const v = at(x, y);
    const e = Math.min(x, MIR(x));                         // columns in from either end
    if(e <= 91 && v === at(MIR(x), y) && [0, 2, 3, 0xB, WHITE, RED, 0xD].includes(v)) continue;
    if(glint(x, y)) continue;
    clean[y*W + x] = L3 + ribbon(x, y);
  }
  writeIdx('s2-emblem-clean.png', clean, W, H);
  // The top of the banner is also a sprite (Obj0E frame $B), so it can sit in front of Sonic and
  // Tails: a copy of plane A there, which gets the same clearing.
  const top = sprites[0xB][1], tx = 160 + top.ox, ty = 104 + top.oy;
  const topClean = Uint8Array.from(top.px); let same = 0, opaque = 0;
  for(let y = 0; y < top.h; y++) for(let x = 0; x < top.w; x++){
    const i = y*top.w + x; if(!top.px[i]) continue; opaque++;
    const X = tx + x, Y = ty + y; if(X < 0 || X >= W) continue;
    if(top.px[i] === emblem[Y*W + X]){ same++; topClean[i] = clean[Y*W + X]; }
  }
  if(same / opaque < 0.9) throw new Error('the banner-top sprite is not a copy of plane A');
  writeIdx('s2-spr-top-clean.png', topClean, top.w, top.h);
  meta.topClean = {ox: top.ox, oy: top.oy, frame: 0xB};

  // The chrome face is S1's: S2's S O N I C are the same letters. They are lifted here as in S1 --
  // their fill colours, and white with fill above it in the column -- only to check that, and to
  // measure where they sit; the shapes used are S1's, which the curled ends and the glint do not
  // reach into.
  // (the curled ends' pixels, which match their mirrors, are left out, as in the clearing)
  const end = (x, y) => Math.min(x, MIR(x)) <= 91 && at(x, y) === at(MIR(x), y);
  const FILL = new Set([3, 4, 5, 0xB, 9, 8, 7]), LIFT = {S: [86, 114], O: [114, 150], N: [150, 185], I: [185, 204], C: [204, 238]};
  const TOP = 108, ROWS = 26;
  const shapes = {...DESIGNS}, spans = {};
  for(const [k, [a, b]] of Object.entries(LIFT)){
    const m = new Set();
    for(let x = a; x < b; x++){ let f = false;
      for(let y = TOP; y <= TOP + ROWS + 2; y++){
        if(glint(x, y) || end(x, y)) continue;
        const v = at(x, y);
        if(FILL.has(v)){ f = true; m.add(x*1000 + y); } else if(v === WHITE && f) m.add(x*1000 + y); else if(v === BLACK) f = false;
      } }
    for(const v of [...m]){ const x = Math.floor(v/1000), y = v % 1000;
      if([[1,0],[-1,0],[0,1],[0,-1]].filter(([dx, dy]) => m.has((x+dx)*1000 + y+dy)).length < 2) m.delete(v); }
    const xs = [...m].map(v => Math.floor(v/1000)), ys = [...m].map(v => v % 1000);
    spans[k] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  }
  // the I is straight-sided, so its first and last rows are the face's
  const y0 = spans.I[2];
  if(spans.I[3] - y0 + 1 !== ROWS) throw new Error(`the I is ${spans.I[3] - y0 + 1} rows, not ${ROWS}`);
  for(const [k, [a, b]] of Object.entries(LIFT)){
    const [x0, x1] = spans[k], m = new Set();
    for(let x = a; x < b; x++){ let f = false;
      for(let y = TOP; y <= y0 + ROWS + 2; y++){
        if(glint(x, y) || end(x, y)) continue;
        const v = at(x, y);
        if(FILL.has(v)){ f = true; m.add(x*1000 + y); } else if(v === WHITE && f) m.add(x*1000 + y); else if(v === BLACK) f = false;
      } }
    const lifted = Array.from({length: ROWS}, (_, i) => Array.from({length: x1 - x0 + 1}, (_, j) => m.has((x0 + j)*1000 + y0 + i) ? '#' : '.').join(''));
    let diff = 0, all = 0;
    for(let y = 0; y < ROWS; y++) for(let x = 0; x < Math.max(lifted[0].length, SONIC[k][0].length); x++){
      const a = lifted[y][x] === '#', b = SONIC[k][y][x] === '#'; if(a || b) all++; if(a !== b) diff++; }
    if(diff / all > 0.07) throw new Error(`S2's ${k} is ${diff} pixels off S1's`);
    shapes[k] = SONIC[k];
  }
  const ix = Math.round((spans.I[0] + spans.I[1]) / 2);
  const gradient = Array.from({length: ROWS}, (_, i) => L3 + at(ix, y0 + i));
  // the gaps between the lifted letters
  const order = ['S', 'O', 'N', 'I', 'C'], gaps = order.slice(1).map((k, i) => spans[k][0] - spans[order[i]][1] - 1);
  const gap = gaps.slice().sort((p, q) => p - q)[2];
  // The small face: T H E D G O lifted from rows 140-145 (white); the rest are S1's.
  const small = {...SMALL}, words = ['T', 'H', 'E', null, 'H', 'E', 'D', 'G', 'E', 'H', 'O', 'G'];
  let col = 110, k = 0;
  const lit = c => [...Array(6)].some((_, i) => at(c, 140 + i) === WHITE);
  const lifted = {};
  while(col < 210 && k < words.length){
    while(col < 210 && !lit(col)) col++;
    const s0 = col; while(lit(col)) col++;
    if(words[k] === null) k++;
    const ch = words[k++];
    if(ch && !lifted[ch]) lifted[ch] = Array.from({length: 6}, (_, i) =>
      Array.from({length: col - s0}, (_, j) => at(s0 + j, 140 + i) === WHITE ? '#' : '.').join(''));
  }
  for(const c of 'THEDGO') if(!lifted[c]) throw new Error('small ' + c + ' was not lifted');
  Object.assign(small, lifted);
  const logo = {chrome: shapes, gradient, small, top: y0, smallTop: 140, cx: 160, gap, space: 12, smallGap: 1, smallSpace: 7,
                depth: 3, spread: 16, lean: 3, black: L3 + BLACK, white: L3 + WHITE};
  fs.writeFileSync(OUT + 's2-logo.json', JSON.stringify(logo));
  console.log(`  logo: arch checked on ${checked} columns; SONIC from row ${y0}, gaps ${gaps.join(',')}; ` +
              `S1's designs ${Object.keys(DESIGNS).length}, small ${Object.keys(small).length}`);
  for(const c of 'SONIC') console.log(`    ${c} ${shapes[c][0].length} wide`);
}
fs.writeFileSync(OUT + 's2-meta.json', JSON.stringify(meta));

// ---- the lettering -----------------------------------------------------------------------------------
// The credit font: the face of SONIC AND MILES 'TAILS' PROWER IN, the screen before the title, and
// of the staff roll. A white outline round a hollow letter, one tile tall and two wide: creditText
// writes each letter as its upper-case code then its lower-case one, through the charset s2.asm sets
// up for the intro text (tiles from $500). I's right half is the 1's. Single-tile marks are 8 wide.
const credArt = nemDecode(rd('S2_CreditText.nem'));
const UPPER = [1,3,5,7,9,0xB,0xD,0xF,0x11,0x12,0x14,0x16,0x18,0x1A,0x1C,0x1E,0x20,0x22,0x24,0x26,0x28,0x2A,0x2C,0x2E,0x30,0x32];
const LOWER = [2,4,6,8,0xA,0xC,0xE,0x10,0x11,0x13,0x15,0x17,0x19,0x1B,0x1D,0x1F,0x21,0x23,0x25,0x27,0x29,0x2B,0x2D,0x2F,0x31,0x33];
const TILES = {};
for(let i = 0; i < 26; i++) TILES[String.fromCharCode(65 + i)] = [UPPER[i], LOWER[i]];
Object.assign(TILES, {I: [0x11, 0x3C], 1: [0x3B, 0x3C], 2: [0x34, 0x35], 9: [0x3D, 0x3E],
                      '(': [0x36], ')': [0x37], "'": [0x38], '.': [0x39], ':': [0x3F]});
const rowsOf = ts => Array.from({length: 8}, (_, y) => ts.map(t => Array.from({length: 8}, (_, x) => {
  const b = credArt[t*32 + y*4 + (x >> 1)]; return (x & 1 ? b & 15 : b >> 4) ? '#' : '.'; }).join('')).join(''));
const cglyphs = {};
for(const [c, ts] of Object.entries(TILES)) cglyphs[c] = {rows: rowsOf(ts), from: 'credits'};
// The intro and the roll never spell Q, but the art has it; they never use the other digits or
// these marks, which are drawn here in the face's own way -- the digits on 2's and 9's outlines,
// 0 is O, 6 is 9 turned round.
const drawn = {
  3: ['..###########...', '.##.........##..', '.########....#..', '........#...#...', '.########....#..', '.#...........#..', '.##.........##..', '..###########...'],
  4: ['.######.######..', '.#....#.#....#..', '.#....###....#..', '.#...........#..', '.########....#..', '........#....#..', '........#....#..', '........######..'],
  5: ['.#############..', '.#...........#..', '.#....########..', '.#..........##..', '.########....#..', '.########....#..', '.#..........##..', '.############...'],
  7: ['.#############..', '.#...........#..', '.#######....#...', '......#....#....', '.....#....#.....', '....#....#......', '....#....#......', '....######......'],
  8: ['..###########...', '.##.........##..', '.#....###....#..', '..#.........#...', '.#....###....#..', '.#....###....#..', '.##.........##..', '..###########...'],
  '!': ['..####..', '..#..#..', '..#..#..', '..#..#..', '..####..', '........', '..####..', '..####..'],
  '-': ['........', '........', '.######.', '.#....#.', '.######.', '........', '........', '........'],
  ',': ['........', '........', '........', '........', '..####..', '..#..#..', '..####..', '..##....'],
  '?': ['...########.....', '..##......##....', '..#####....#....', '......#...##....', '......#####.....', '................', '......####......', '......####......'],
  '&': ['...######.......', '..##....##......', '..##....##......', '...##..##..##...', '..##.##..####...', '.##...##..##....', '.##....##..##...', '..######..####..'],
};
drawn[0] = cglyphs.O.rows;
drawn[6] = cglyphs[9].rows.slice().reverse().map(r => [...r].reverse().join('').slice(1) + '.');
for(const [c, rows] of Object.entries(drawn)) cglyphs[c] = {rows, from: 'drawn'};
if(cglyphs[6].rows.some(r => r.length !== 16)) throw new Error('6 is not 16 wide');

const corder = Object.keys(cglyphs).sort();
const CW = corder.reduce((a, c) => a + cglyphs[c].rows[0].length + 2, 0), catlas = new Uint8Array(CW * 8);
const ctable = {rowh: 8, glyphs: {}};
let cx = 0;
for(const c of corder){
  const r = cglyphs[c].rows, w = r[0].length;
  r.forEach((row, y) => [...row].forEach((v, x) => { if(v === '#') catlas[y*CW + cx + x] = 6; }));
  ctable.glyphs[c] = [cx, 0, w, 8, 0];
  cx += w + 2;
}
// Pal_BGND's line 0, which the intro text is drawn in: colour 6 is the white
const credPal = words(rd('S2_Pal_SonicAndTails.bin')).map(rgb);
fs.writeFileSync(OUT + 's2cred-atlas.png', encodeIndexedPng(catlas, CW, 8, credPal, 0));
fs.writeFileSync(OUT + 's2cred-table.json', JSON.stringify(ctable));
console.log(`s2cred-atlas.png ${CW}x8  ${corder.length} glyphs (${corder.filter(c => cglyphs[c].from === 'drawn').join('')} drawn)`);
console.log(`s2-meta.json     ${fs.statSync(OUT + 's2-meta.json').size}B, ${FRAMES} frames, ${pals.length} palettes`);


// ==== the title card ==================================================================================
// Obj34 over ArtNem_TitleCard (tiles $580-$5DD: E N O Z, the act numbers, SONIC THE HEDGEHOG, the red
// stripes and the three fill tiles) and the letter font ArtNem_TitleCard2, which LoadTitleCard copies
// into VRAM a zone's letters at a time. Palette lines 0 and 1 are Pal_BGND's, loaded for the card.
const cardArt = new Uint8Array(0x800 * 32);
cardArt.set(nemDecode(rd('S2_TitleCard.nem')), 0x580 * 32);
const letterArt = nemDecode(rd('S2_TitleCard2.nem'));
const cardPal = [...words(rd('S2_Pal_SonicAndTails.bin')), ...words(rd('S2_Pal_SonicAndTails2.bin'))];
// a column-major block of tiles, 16 rows tall: what a 2-tall sprite piece draws
function block(art, t, wt, ht = 2){
  const w = wt*8, h = ht*8, px = new Array(w*h).fill(0);
  for(let cx = 0; cx < wt; cx++) for(let cy = 0; cy < ht; cy++) for(let y = 0; y < 8; y++) for(let x = 0; x < 8; x++){
    const b = art[(t + cx*ht + cy)*32 + y*4 + (x >> 1)];
    px[(cy*8 + y)*w + cx*8 + x] = x & 1 ? b & 15 : b >> 4;
  }
  return {w, px};
}
// The font's letters, at the offsets the title-card charset gives them -- each 2x2 tiles, I 1x2, M
// and W 3x2 -- and E N O Z, which the base art holds for ZONE. B, J, Q, V and X spell no zone, but
// they are in the font.
const kglyphs = {};
const LETTER = {A: 0, B: 4, C: 8, D: 0xC, F: 0x10, G: 0x14, H: 0x18, I: 0x1C, J: 0x1E, K: 0x22, L: 0x26, M: 0x2A,
                P: 0x30, Q: 0x34, R: 0x38, S: 0x3C, T: 0x40, U: 0x44, V: 0x48, W: 0x4C, X: 0x52, Y: 0x56};
for(const [c, t] of Object.entries(LETTER)) kglyphs[c] = {...block(letterArt, t, c === 'I' ? 1 : c === 'M' || c === 'W' ? 3 : 2), from: 'card'};
for(const [c, t] of Object.entries({E: 0x580, N: 0x584, O: 0x588, Z: 0x58C})) kglyphs[c] = {...block(cardArt, t, 2), from: 'card'};
kglyphs['.'] = {...block(letterArt, 0x5A, 1), from: 'card'};
// The face is white (6), anti-aliased grey (7, 8), with a black drop shadow two pixels right and two
// down wherever the face is not. Checked against the real letters; the drawn glyphs get it too.
const kshadow = (rows) => {
  const w = rows[0].length, h = 16, px = new Array(w*h).fill(0);
  const face = (x, y) => y >= 0 && y < rows.length && x >= 0 && x < w && rows[y][x] !== '.';
  for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
    if(face(x, y)) px[y*w + x] = +rows[y][x] || 6;
    else if(face(x - 2, y - 2)) px[y*w + x] = 1;
  }
  return {w, px};
};
{
  let hit = 0, all = 0;
  for(const c of 'ADEHLT'){
    const g = kglyphs[c], rows = Array.from({length: 16}, (_, y) => Array.from({length: g.w}, (_, x) => [6, 7, 8].includes(g.px[y*g.w + x]) ? '6' : '.').join(''));
    const d = kshadow(rows);
    for(let i = 0; i < g.px.length; i++) if(g.px[i] === 1){ all++; if(d.px[i] === 1) hit++; }
  }
  if(hit / all < 0.85) throw new Error(`the title-card shadow rule matches only ${hit}/${all} real shadow pixels`);
  console.log(`  card: shadow rule matches ${hit}/${all} of the real letters' shadow pixels`);
}
// The letters are a thick stem with a thin line beside it, and one-pixel bars; the digits and marks
// are drawn the same way, square like E, L and T. 0 is O.
const kdrawn = {
  1: ['..6666.6', '.66666.6', '666666.6', '..6666.6', '..6666.6', '..6666.6', '..6666.6', '..6666.6', '..6666.6', '..6666.6', '..6666.6', '..6666.6', '..6666.6', '.6666666'],
  2: ['66666666666666', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '66666666666666', '6666.6........', '6666.6........', '6666.6........', '6666.6........', '6666.6........', '6666.6........', '66666666666666'],
  3: ['66666666666666', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '..666666666666', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '66666666666666'],
  4: ['6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '66666666666666', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6'],
  5: ['66666666666666', '6666.6........', '6666.6........', '6666.6........', '6666.6........', '6666.6........', '66666666666666', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '66666666666666'],
  6: ['66666666666666', '6666.6........', '6666.6........', '6666.6........', '6666.6........', '6666.6........', '66666666666666', '6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '66666666666666'],
  7: ['66666666666666', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........6666.6', '........666666'],
  8: ['66666666666666', '6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '66666666666666', '6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '6666.6..6666.6', '66666666666666'],
  '!': ['6666.6', '6666.6', '6666.6', '6666.6', '6666.6', '6666.6', '6666.6', '6666.6', '6666.6', '......', '......', '......', '666666', '666666'],
  '?': ['66666666666666', '6666.6..6666.6', '6666.6..6666.6', '........6666.6', '........6666.6', '........6666.6', '....6666666666', '....6666.6....', '....6666.6....', '....6666.6....', '..............', '..............', '....666666....', '....666666....'],
  "'": ['6666.6', '6666.6', '6666.6', '6666.6', '6666.6'],
  ',': ['......', '......', '......', '......', '......', '......', '......', '......', '......', '......', '......', '......', '666666', '666666', '..66..', '.66...'],
  '-': ['........', '........', '........', '........', '........', '........', '66666666', '66666666'],
  ':': ['......', '......', '......', '666666', '666666', '......', '......', '......', '......', '......', '......', '......', '666666', '666666'],
  '&': ['.6666666666...', '.6666.6.666...', '.6666.6.666...', '..666666666...', '6666.6.666....', '6666.6..666...', '6666.6...666.6', '6666.6....6666', '6666.6....666.', '6666.6...6666.', '6666.6..666666', '6666.6.666..66', '66666666666..6', '66666666666...'],
};
kdrawn[9] = kdrawn[6].slice().reverse().map(r => [...r].reverse().join(''));
for(const [c, rows] of Object.entries(kdrawn)) kglyphs[c] = {...kshadow(rows), from: 'drawn'};
kglyphs[0] = {...kglyphs.O, from: 'card'};

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
const cardRgb = cardPal.map(rgb);
fs.writeFileSync(OUT + 's2card-atlas.png', encodeIndexedPng(katlas, KW, 16, cardRgb.slice(0, 16), 0));
// ZONE ($11), the act numbers ($12-$14), SONIC THE HEDGEHOG ($15) and the red stripes ($16), from
// MapUnc_TitleCards; and the three tiles DrawLevelTitleCard fills plane A with -- blue $5DA, red
// $5D8 stacked down a column, yellow $5DC -- as the areas they cover.
// (the zone-name frames come first, through zoneOffsetTableEntry, which this skips: the six after them)
const cframes = parseS1MapFrames(rd('S2_TitleCards_map.asm').toString());
if(cframes.length !== 6) throw new Error('expected the six frames after the zone names');
function writePart(name, r){
  fs.writeFileSync(OUT + `s2card-${name}.png`, encodeIndexedPng(r.px, r.w, r.h, cardRgb, 0));
  ktable.parts[name] = {ox: r.ox, oy: r.oy, w: r.w, h: r.h};
}
for(const [name, f] of [['zone', 0], ['act1', 1], ['act2', 2], ['act3', 3], ['sth', 4], ['stripes', 5]])
  writePart(name, renderFrame(cframes[f], cardArt));
const fill = (t, w, h, vertical, line) => {
  const px = new Uint8Array(w*h);
  for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
    const tt = vertical ? t + ((y >> 3) & 1) : t + ((x >> 3) & 1), b = cardArt[tt*32 + (y & 7)*4 + ((x & 7) >> 1)];
    const c = x & 1 ? b & 15 : b >> 4;
    px[y*w + x] = c ? line*16 + c : 0;
  }
  return {px, w, h, ox: 0, oy: 0};
};
writePart('blue', fill(0x5DA, 320, 224, false, 0));
writePart('red', fill(0x5D8, 112, 224, true, 0));
writePart('yellow', fill(0x5DC, 320, 64, false, 1));

// ---- Obj34, run frame by frame -----------------------------------------------------------------
// Six objects from Obj34_TitleCardData, in slot order: the zone name, ZONE, the act number, the blue
// background, the yellow bottom part, the red left part. Each waits its count (Obj34_Wait), then
// moves $10 a frame to its target; the background and the two bands also write plane A, which
// DrawLevelTitleCard turns into rows and columns of their fill tiles. Sprites show only while their
// x is within VDP $0-$200. Coordinates here are screen pixels, sprite x less 128.
const PLC_TILES = [24, 8, 20, 28, 38, 22, 16, 60, 32, 34];   // PlrList_Ehz1 then PlrList_Std2, from each file's header
const plcFrames = PLC_TILES.reduce((a, n) => a + Math.ceil(n / 6), 0);  // ProcessDPLC: 6 patterns a frame
const cam = {x: 0, y: 0x28F - 0x60};                     // EHZ1's start, less $A0 and $60, clamped at 0
const card = (() => {
  const o = {
    name:   {x: 448, to: 160, from: 448, wait: 0x1B, first: 2},
    zone:   {x: -88, to: 200, from: -88, wait: 0x1C, first: 1},
    act:    {x: -24, to: 264, from: -24, wait: 0x1C, first: 1},
    bottom: {x: 552, to: 232, from: 552, wait: 8, first: 1, loc: 0x26},
    left:   {x: -128, to: 112, from: -128, wait: 0x15, first: 1, loc: 0},
  };
  let bgLoc = 0, bgRows = 0, yel = null, red = 0, reveal = null, phase = 'in';
  const shown = {};
  const tl = [];
  const vis = x => x + 128 >= 0 && x + 128 <= 0x200;
  const towards = (e, to, v) => { if(e.x !== to){ e.x += e.x < to ? v : -v; } shown[e.k] = vis(e.x); };
  const waitDone = e => { if(e.wait > 1){ e.wait--; return false; } e.wait = 1; return true; };
  for(const [k, e] of Object.entries(o)) e.k = k;
  const record = (extra = {}) => tl.push({bg: bgRows, yel, red, reveal,
    ...Object.fromEntries(Object.entries(o).filter(([k]) => shown[k] && o[k].alive !== false).map(([k, e]) => [k, e.x])), ...extra});
  tl.push({none: 1});                                    // frame 0: before the card exists
  let f = 0, nameAt = -1, rest = -1;
  for(;;){                                              // Level_TtlCard
    f++;
    for(const k of ['name', 'zone', 'act']){ const e = o[k]; if(f < e.first) continue; shown[k] = false; if(waitDone(e)) towards(e, e.to, 16); }
    if(bgLoc !== 0x10){ bgLoc++; bgRows = bgLoc*2; }
    { const e = o.bottom; shown.bottom = false;
      if(waitDone(e)){ if(e.loc >= 0){ yel = e.loc; e.loc -= 2; if(e.loc === 6) e.loc = -1; } towards(e, e.to, 16); } }
    { const e = o.left; shown.left = false;
      if(waitDone(e)){ if(e.loc >= 0){ e.loc += 2; red = e.loc; if(e.loc === 0xE) e.loc = -1; } towards(e, e.to, 16); } }
    record();
    if(o.name.x === o.name.to && rest < 0) rest = tl.length - 1;
    if(o.name.x === o.name.to && f >= 1 + plcFrames) break;
  }
  const loaded = tl.length;
  record();                                              // the WaitForVint before Hud_Base
  // the level loads here, in no frames this page models; then the card goes
  o.left.loc = 0xA; let bottomOut = false, bgOut = false, bgDone = false;
  const objsFrom = tl.length;
  while(!bgDone){
    // slot order: the background, then the bottom part, then the left part
    if(bgOut){
      bgLoc = bgLoc === 'init' ? 0xF0 - 0x20 : bgLoc - 0x20;
      if(bgLoc === -0x30) bgDone = true; else reveal = bgLoc - (cam.y & 15);
    }
    if(bottomOut && o.bottom.alive !== false){
      const e = o.bottom;
      if(e.loc === 0x28){ bgOut = true; bgLoc = 'init'; e.alive = false; shown.bottom = false; yel = null; }
      else { yel = e.loc + 4 >= 40 ? null : e.loc + 4; e.loc += 4; towards(e, e.from, 32); }
    }
    if(o.left.alive !== false){
      const e = o.left;
      if(e.loc < 0){ bottomOut = true; o.bottom.loc = 0; e.alive = false; shown.left = false; }
      else { red = e.loc; yel = Math.min(yel ?? 40, e.loc); e.loc -= 4; if(e.loc === -2) e.loc = 0; towards(e, e.from, 32); }
    }
    record({objs: 1});
  }
  const mainFrom = tl.length;
  for(const k of ['name', 'zone', 'act']){ o[k].hold = 0x2D; }
  while(['name', 'zone', 'act'].some(k => o[k].alive !== false)){
    for(const k of ['name', 'zone', 'act']){
      const e = o[k]; if(e.alive === false) continue;
      if(e.hold){ e.hold--; shown[k] = vis(e.x); continue; }
      if(e.x === e.from){ e.alive = false; shown[k] = false; continue; }
      e.x += e.x < e.from ? 32 : -32;
      if(!vis(e.x)){ e.alive = false; shown[k] = false; continue; }
      shown[k] = true;
    }
    record({objs: 1, main: tl.length - mainFrom});
  }
  return {tl, rest, loaded, objsFrom, mainFrom, plcFrames};
})();
ktable.card = {...card, name: {right: 128, y: 56}, zone: {y: 80}, act: {y: 80}, sth: {y: 160}, stripes: {y: 112}};
fs.writeFileSync(OUT + 's2card-table.json', JSON.stringify(ktable));
console.log(`s2card-atlas.png ${KW}x16  ${korder.length} glyphs (${korder.filter(c => kglyphs[c].from === 'drawn').join('')} drawn); ` +
            `${card.tl.length} card frames, at rest on ${card.rest}, level from ${card.loaded}`);


// ==== Emerald Hill Zone act 1 ==========================================================================
// The level at its start: Sonic at ($60,$28F), Tails $20 behind and 4 lower, the camera at (0,$22F).
// EHZ_HTZ art (Kosinski) at tile 0; 16x16 blocks of four tile words; 128x128 chunks of 8x8 block words
// (bits 0-9 the block, 10-11 its flips); the layout's rows alternate foreground and background, $80
// bytes each. Pal_EHZ is lines 1-3, over Pal_BGND's line 0.
const kos = f => Buffer.from(kosDecode(rd(f)).data);
const lvArt = kos('S2_EHZ_Art.kos'), lvBlocks = kos('S2_EHZ_Blocks.kos'), lvChunks = kos('S2_EHZ_Chunks.kos'), lvLayout = kos('S2_EHZ1_Layout.kos');
const lvVram = new Uint8Array(0x800 * 32); lvVram.set(lvArt, 0);
// LoadAnimatedBlocks: APM_EHZ's blocks go in at the end of the table (Block_Table + $1800 - their
// length), drawn from the tiles Animated_EHZ reloads. make_block_tile(tile, xflip, yflip, pal, pri).
const mbt = (t, xf, yf, pal, pri) => (pri << 15) | (pal << 13) | (yf << 12) | (xf << 11) | t;
const MTN = 0x500, PULSE = 0x39C, CHECK = 0x158, FL = [0x394, 0x396, 0x398, 0x39A];
const APM = [
  ...[[0, 4, 1, 5], [8, 0xC, 9, 0xD], [0x10, 0x14, 0x11, 0x15], [2, 6, 3, 7], [0xA, 0xE, 0xB, 0xF], [0x12, 0x16, 0x13, 0x17]]
     .flatMap(q => q.map(o => mbt(MTN + o, 0, 0, 2, 0))),
  ...[[0x18, 0x1A, 0x19, 0x1B], [0x1C, 0x1E, 0x1D, 0x1F]].flatMap(q => q.map(o => mbt(MTN + o, 0, 0, 3, 0))),
  mbt(PULSE, 0, 0, 2, 0), mbt(PULSE, 1, 0, 2, 0), mbt(PULSE + 1, 0, 0, 2, 0), mbt(PULSE + 1, 1, 0, 2, 0),
  mbt(CHECK, 0, 0, 2, 0), mbt(PULSE, 0, 0, 2, 0), mbt(CHECK + 1, 0, 0, 2, 0), mbt(PULSE + 1, 0, 0, 2, 0),
  mbt(PULSE, 1, 0, 2, 0), mbt(CHECK, 1, 0, 2, 0), mbt(PULSE + 1, 1, 0, 2, 0), mbt(CHECK + 1, 1, 0, 2, 0),
  ...FL.flatMap((t, i) => [mbt(t, 0, 0, 3, i & 1), mbt(t, 1, 0, 3, i & 1), mbt(t + 1, 0, 0, 3, i & 1), mbt(t + 1, 1, 0, 3, i & 1)]),
];
const blockWords = Array.from({length: 0x300*4}, (_, i) => i*2 < lvBlocks.length ? lvBlocks.readUInt16BE(i*2) : 0);
const apmAt = (0x1800 - APM.length*2) / 2;
if(apmAt*2 < lvBlocks.length) throw new Error('the animated blocks would overwrite real ones');
APM.forEach((w, i) => { blockWords[apmAt + i] = w; });
// Animated_EHZ: [the art, its VRAM tile, the frames as [tile offset, duration]]. Each script's first
// frame is loaded by AniArt_Load before the level starts; then Dynamic_Normal steps it once a frame
// of the main loop -- a frame lasts its duration + 1.
const ANIM = [
  {art: 'S2_EHZ_Flowers1.unc', tile: FL[0], frames: [[0, 0x7F], [2, 0x13], [0, 7], [2, 7], [0, 7], [2, 7]]},
  {art: 'S2_EHZ_Flowers2.unc', tile: FL[1], frames: [[2, 0x7F], [0, 0xB], [2, 0xB], [0, 0xB], [2, 5], [0, 5], [2, 5], [0, 5]]},
  {art: 'S2_EHZ_Flowers3.unc', tile: FL[2], frames: [[0, 7], [2, 7]]},
  {art: 'S2_EHZ_Flowers4.unc', tile: FL[3], frames: [[0, 0x7F], [2, 7], [0, 7], [2, 7], [0, 7], [2, 0xB], [0, 0xB], [2, 0xB]]},
  {art: 'S2_EHZ_PulseBall.unc', tile: PULSE, frames: [[0, 0x17], [2, 9], [4, 0xB], [6, 0x17], [4, 0xB], [2, 9]]},
];
for(const a of ANIM){ a.sheet = rd(a.art); lvVram.set(a.sheet.subarray(a.frames[0][0]*32, (a.frames[0][0] + 2)*32), a.tile*32); }
const animOf = t => ANIM.findIndex(a => t >= a.tile && t < a.tile + 2);
function lvWord(x, y, bg){
  const id = lvLayout[(y >> 7)*0x100 + (bg ? 0x80 : 0) + (x >> 7)];
  const cw = lvChunks.readUInt16BE(id*128 + ((y >> 4) & 7)*16 + ((x >> 4) & 7)*2), b = cw & 0x3FF;
  let qx = (x >> 3) & 1, qy = (y >> 3) & 1;
  if(cw & 0x400) qx ^= 1; if(cw & 0x800) qy ^= 1;
  let w = blockWords[b*4 + qy*2 + qx];
  if(cw & 0x400) w ^= 0x800; if(cw & 0x800) w ^= 0x1000;
  return w;
}
function lvPixel(w, X, Y){
  const t = w & 0x7FF, sx = w & 0x800 ? 7 - (X & 7) : X & 7, sy = w & 0x1000 ? 7 - (Y & 7) : Y & 7;
  const b = lvVram[t*32 + sy*4 + (sx >> 1)], c = sx & 1 ? b & 15 : b >> 4;
  return c ? ((w >> 13) & 3)*16 + c : 0;
}
// plane A: the foreground at the camera, split by priority. Cells drawn from an animated script's
// tiles are left out and kept, per script and frame, as overlays the page swaps.
const fgLo = new Uint8Array(W*H), fgHi = new Uint8Array(W*H), animCells = [];
for(let y = 0; y < H; y++) for(let x = 0; x < W; x++){
  const X = x + cam.x, Y = y + cam.y, w = lvWord(X, Y, false), a = animOf(w & 0x7FF);
  if(a >= 0){ animCells.push({x, y, w, a, X, Y}); continue; }
  const v = lvPixel(w, X, Y);
  if(v) (w & 0x8000 ? fgHi : fgLo)[y*W + x] = v;
}
writeIdx('ehz-fg.png', fgLo, W, H);
writeIdx('ehz-fg-hi.png', fgHi, W, H);
const ehzAnim = [];
for(const ai of new Set(animCells.map(c => c.a))){
  const a = ANIM[ai], cells = animCells.filter(c => c.a === ai);
  const x0 = Math.min(...cells.map(c => c.x)), y0 = Math.min(...cells.map(c => c.y));
  const w = Math.max(...cells.map(c => c.x)) - x0 + 1, h = Math.max(...cells.map(c => c.y)) - y0 + 1;
  const layers = {};
  for(const off of new Set(a.frames.map(f => f[0]))){
    lvVram.set(a.sheet.subarray(off*32, (off + 2)*32), a.tile*32);
    for(const hi of [0, 1]){
      const px = new Uint8Array(w*h);
      for(const c of cells) if(!!(c.w & 0x8000) === !!hi){ const v = lvPixel(c.w, c.X, c.Y); if(v) px[(c.y - y0)*w + c.x - x0] = v; }
      if(!px.some(v => v)) continue;
      const name = `ehz-anim${ai}-${off}-${hi}.png`;
      writeIdx(name, px, w, h);
      layers[`${off}-${hi}`] = name;
    }
  }
  lvVram.set(a.sheet.subarray(a.frames[0][0]*32, (a.frames[0][0] + 2)*32), a.tile*32);
  ehzAnim.push({x: x0, y: y0, frames: a.frames, layers});
}
console.log(`  EHZ: animated tiles on screen from ${ehzAnim.length} script(s): ${[...new Set(animCells.map(c => c.a))].join(', ')}`);
// plane B: DrawInitialBG draws 512px of background from the BG camera, (0,0) here (InitCam_EHZ), and
// nothing redraws it while the camera stands still.
const ehzBg = new Uint8Array(BG_W * H);
for(let y = 0; y < H; y++) for(let x = 0; x < BG_W; x++){
  const w = lvWord(x, y, true);
  if(w & 0x8000) throw new Error('a background tile is high priority');
  if(animOf(w & 0x7FF) >= 0) throw new Error('animated tiles in the background');
  const v = lvPixel(w, x, y); if(v) ehzBg[y*BG_W + x] = v;
}
writeIdx('ehz-bg.png', ehzBg, BG_W, H);

// ---- the sprites ----------------------------------------------------------------------------------
// Sonic and Tails load their art per frame (DPLCs) from their uncompressed sheets; Tails' tails are
// his own sheet's frames 9-$D. All three on palette line 0, low priority. Rings: ArtNem_Ring on line 1.
function dplcFrame(map, dplc, sheet, f, line){
  const tiles = [];
  for(const [n, off] of dplc[f]) for(let i = 0; i < n; i++) tiles.push(sheet.subarray((off + i)*32, (off + i + 1)*32));
  const art = new Uint8Array(tiles.length * 32); tiles.forEach((t, i) => art.set(t, i*32));
  return renderFrame(map[f], art, {line});
}
const sonicMap = parseS1MapFrames(rd('S2_Sonic_map.asm').toString()), sonicDplc = parseMacroDplcFrames(rd('S2_Sonic_dplc.asm').toString());
const tailsMap = parseS1MapFrames(rd('S2_Tails_map.asm').toString()), tailsDplc = parseMacroDplcFrames(rd('S2_Tails_dplc.asm').toString());
const sonicSheet = rd('S2_Sonic.unc'), tailsSheet = rd('S2_Tails.unc');
const ehzSprites = {}, ehzSpritePx = {};
const spr = (name, r) => { writeIdx(`ehz-${name}.png`, r.px, r.w, r.h); ehzSprites[name] = {ox: r.ox, oy: r.oy}; ehzSpritePx[name] = r; };
spr('sonic', dplcFrame(sonicMap, sonicDplc, sonicSheet, 1, 0));             // SonAni_Wait's frame for its first 180
// TailsAni_Wait: duration 7, frames 1 x10, 3, 2 (a blink), 1 ...; Obj05Ani_Swish: duration 7, 9-$D
const TAILS_WAIT = [1,1,1,1,1,1,1,1,1,1,3,2,1,1,1,1,1,1,1,1,3,2,1,1,1,1,1,1,1,1,1,5];
for(const f of new Set(TAILS_WAIT)) spr(`tails${f}`, dplcFrame(tailsMap, tailsDplc, tailsSheet, f, 0));
for(const f of [9, 10, 11, 12, 13]) spr(`tail${f}`, dplcFrame(tailsMap, tailsDplc, tailsSheet, f, 0));
const ringArt = nemDecode(rd('S2_Ring.nem')), ringMap = parseS1MapFrames(rd('S2_Ring_map.asm').toString());
for(const f of [0, 1, 2, 3]) spr(`ring${f}`, renderFrame(ringMap[f], ringArt, {line: 1}));
// Rings_EHZ_1 puts three in a row at ($124,$240), 24 apart: the first two are on screen. BuildRings'
// +8 and -8 cancel, so each is drawn at its position less the camera's.
const rings = [0x124, 0x13C].map(x => ({x: x - cam.x, y: 0x240 - cam.y}));

// ---- palettes ---------------------------------------------------------------------------------------
// While the card is up, Pal_BGND is lines 0-1 and lines 2-3 are still black from the fade; the level
// brings Pal_EHZ's lines 1-3 (line 1 is the card's line 1 again). In the level PalCycle_EHZ steps the
// water colours -- line 1, colours 3-4 and 14-15 -- every 8 frames through four states.
const lvPal = words(rd('S2_Pal_EHZ.bin')), water = words(rd('S2_Pal_EHZWater.bin'));
if(lvPal.length !== 48 || water.length !== 16) throw new Error('unexpected EHZ palette sizes');
const phex = p => p.map(c => c.toString(16).padStart(3, '0')).join('');
const ehzPals = [phex([...cardPal, ...new Array(32).fill(0)])];
for(let k = 0; k < 4; k++){
  const p = [...cardPal.slice(0, 16), ...lvPal];
  [p[16 + 3], p[16 + 4], p[16 + 14], p[16 + 15]] = water.slice(k*4, k*4 + 4);
  ehzPals.push(phex(p));
}
const ehzMeta = {pals: ehzPals, tailsWait: TAILS_WAIT, anim: ehzAnim, sprites: ehzSprites, rings, ripple,
                 sonic: {x: 0x60 - cam.x, y: 0x28F - cam.y}, tails: {x: 0x40 - cam.x, y: 0x293 - cam.y},
                 rippleTop: 80, rippleLines: 21, bgOutInit: card.tl.findIndex(e => e.reveal !== null && e.reveal !== undefined),
                 objsFrom: card.objsFrom, mainFrom: card.mainFrom, cardFrames: card.tl.length};

// ---- the still: the level standing, frame 0 of its own loop -------------------------------------------
// The water lines ripple from the start of SwScrl_RippleData; the page takes the frame counter as one
// short of a step there, so its first step back comes 8 frames on.
{
  const out = new Uint8Array(W*H).fill(32);
  for(let y = 0; y < H; y++){
    const s = y >= 80 && y < 101 ? ripple[y - 80] : 0;
    for(let x = 0; x < W; x++){ const v = ehzBg[y*BG_W + ((x - s) & 511)]; if(v) out[y*W + x] = v; }
  }
  for(let i = 0; i < W*H; i++) if(fgLo[i]) out[i] = fgLo[i];
  for(const c of animCells) if(!(c.w & 0x8000)){ const v = lvPixel(c.w, c.X, c.Y); if(v) out[c.y*W + c.x] = v; }
  const put = (name, X, Y) => { const f = ehzSpritePx[name]; for(let y = 0; y < f.h; y++) for(let x = 0; x < f.w; x++){
    const v = f.px[y*f.w + x], sx = X + f.ox + x, sy = Y + f.oy + y; if(v && sx >= 0 && sx < W && sy >= 0 && sy < H) out[sy*W + sx] = v; } };
  // back to front: the rings, Tails' tails, Tails, Sonic (slot order, all priority 2 bar the rings)
  for(const r of rings) put('ring1', r.x, r.y);
  put('tail9', ehzMeta.tails.x, ehzMeta.tails.y);
  put('tails1', ehzMeta.tails.x, ehzMeta.tails.y);
  put('sonic', ehzMeta.sonic.x, ehzMeta.sonic.y);
  for(let i = 0; i < W*H; i++) if(fgHi[i]) out[i] = fgHi[i];
  for(const c of animCells) if(c.w & 0x8000){ const v = lvPixel(c.w, c.X, c.Y); if(v) out[c.y*W + c.x] = v; }
  const p = ehzPals[1];
  fs.writeFileSync(OUT + 'ehz-still.png', encodeIndexedPng(out, W, H, Array.from({length: 64}, (_, i) => rgb(parseInt(p.slice(i*3, i*3 + 3), 16))), -1));
  console.log(`ehz-still.png    320x224  ${fs.statSync(OUT + 'ehz-still.png').size}B`);
}
fs.writeFileSync(OUT + 'ehz-meta.json', JSON.stringify(ehzMeta));
