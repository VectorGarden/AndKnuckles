/* Builds the Angel Island Zone intro: the Tornado over the ocean, Super Sonic,
   the beach, Knuckles and the emeralds -- from the first frame of AIZ1 to the
   frame before control is handed to the player.
   Run it with:  node tools/build-aiz-assets.mjs [outDir]

   Unlike the title screens this is a cutscene running in the level engine, so
   the build does what the engine does, offline: it decodes the level, steps
   every object the way its routine does, frame by frame, and writes

     aiz-fg.png / aiz-fg-hi.png   plane A across the camera's path, split by tile
                                  priority, since the island's high tiles bury
                                  Knuckles and cover Super Sonic's lower half
     aiz-bg.png                   plane B, which the page line-scrolls
     aiz-sprites.png              every sprite frame that appears, packed
     aiz-still.png                the last frame, for the still and intro-off
     aiz-meta.json                per-frame camera, background scroll, palette
                                  and sprite list

   The layers hold palette *indices* -- line*16 + colour, as grey levels g*4 --
   not colours, because the palette never stops moving: a fade, the ocean's
   cycle, Super Sonic's, the AIZ palette swap, then Knuckles' and the emeralds'.
   The page colours each frame from the palette that frame had.

   Frame numbers below (F1...) are LevelLoop iterations; F758 is the knockback.
   Labels and line numbers are sonic3k.asm in sonicretro/skdisasm. */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {kosDecode, kosMDecode} from './lib/kosinski.mjs';
import {nemDecode} from './lib/nemesis.mjs';
import {encodeIndexedPng} from './lib/png.mjs';
import {parseMapTables, parseDplcTables, renderFrame} from './lib/sprite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D    = path.join(HERE, 'rom') + path.sep;
const OUT  = (process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, 'out')) + path.sep;
fs.mkdirSync(OUT, {recursive: true});
const rd = f => fs.readFileSync(D + f);
const s16 = v => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
const words = buf => Array.from({length: buf.length >> 1}, (_, i) => buf.readUInt16BE(i*2));

// ---- the level, as LevelLoadBlock entry 0 loads it for the intro ------------
// Secondary tiles go straight after Primary's (tile $BE); Secondary blocks are
// appended to Primary's. Chunks are one file. Block entries hold absolute tiles.
const tilesP = kosMDecode(rd('AIZ1_Tiles_Primary.kosm'));
const tilesS = kosMDecode(rd('AIZ1_Tiles_Secondary.kosm'));
if(tilesP.length !== 0xBE*32) throw new Error('primary tiles are not $BE tiles');
const vram = new Uint8Array(0x800*32);
vram.set(tilesP, 0); vram.set(tilesS, tilesP.length);
const blocks = Buffer.concat([Buffer.from(kosDecode(rd('AIZ1_Blocks_Primary.kos')).data),
                              Buffer.from(kosDecode(rd('AIZ1_Blocks_Secondary.kos')).data)]);
const chunks = Buffer.from(kosDecode(rd('AIZ1_Chunks.kos')).data);
const layout = rd('AIZ1_Layout.bin');
const coll = rd('AIZ1_Collision.bin'), heights = rd('Height_Maps.bin');
const [FG_W, BG_W] = [layout.readUInt16BE(0), layout.readUInt16BE(2)];

// The chunk word at a world pixel (Find_Tile_FG): row pointers every 4 bytes,
// FG then BG, one chunk byte per column.
function chunkWord(x, y, bg){
  const p = layout.readUInt16BE(8 + ((y >> 5) & 0x7C) + (bg ? 2 : 0));
  if(!p) return 0;
  const ch = layout[p - 0x8000 + ((x >> 7) % (bg ? BG_W : FG_W))];
  return chunks.readUInt16BE(ch*0x80 + (y & 0x70) + ((x >> 3) & 0xE));
}
// The nametable word drawn at a pixel: the block's quarter, with the chunk's
// flips folded in the way Setup_TileRowDraw does.
function pattern(x, y, bg){
  const w = chunkWord(x, y, bg), b = w & 0x3FF;
  let qx = (x >> 3) & 1, qy = (y >> 3) & 1;
  if(w & 0x400) qx ^= 1;
  if(w & 0x800) qy ^= 1;
  let pw = blocks.readUInt16BE(b*8 + (qy*2 + qx)*2);
  if(w & 0x400) pw ^= 0x800;
  if(w & 0x800) pw ^= 0x1000;
  return pw;
}
/* A plane region as two index layers, low and high priority. */
function renderPlane(bg, x0, y0, w, h){
  const lo = new Uint8Array(w*h), hi = new Uint8Array(w*h), tiles = new Set();
  for(let ty = y0 & ~7; ty < y0 + h; ty += 8) for(let tx = x0 & ~7; tx < x0 + w; tx += 8){
    const pw = pattern(tx, ty, bg), t = pw & 0x7FF;
    const hf = (pw >> 11) & 1, vf = (pw >> 12) & 1, line = (pw >> 13) & 3;
    const out = pw & 0x8000 ? hi : lo;
    if(t) tiles.add(t);
    for(let y = 0; y < 8; y++) for(let x = 0; x < 8; x++){
      const X = tx + x - x0, Y = ty + y - y0;
      if(X < 0 || X >= w || Y < 0 || Y >= h) continue;
      const sx = hf ? 7-x : x, sy = vf ? 7-y : y;
      const b = vram[t*32 + sy*4 + (sx >> 1)], c = (sx & 1) ? (b & 15) : (b >> 4);
      if(c) out[Y*w + X] = line*16 + c;
    }
  }
  return {lo, hi, tiles};
}

// Floor distance below a point (FindFloor, top-solid path 1, S3 collision):
// negative means the point is inside the floor by that much.
function probe(x, y, full = true){
  const w = chunkWord(x, y, false), b = w & 0x3FF;
  const empty = () => full ? probe(x, y + 16, false) + 16 : 0xF - (y & 0xF);
  if(!b || !((w >> 0xC) & 1)) return empty();
  const ci = coll[1 + 2*b];
  if(!ci) return empty();
  let h = heights[ci*16 + ((w & 0x400 ? ~x : x) & 0xF)];
  if(h > 127) h -= 256;
  if(w & 0x800) h = -h;
  if(!h) return empty();
  if(h < 0){
    if((y & 0xF) + h >= 0) return empty();
    return full ? probe(x, y - 16, false) - 16 : 0xF - (y & 0xF);
  }
  if(h === 16 && full) return probe(x, y - 16, false) - 16;
  return 0xF - ((y & 0xF) + h);
}

// ---- sprites ----------------------------------------------------------------
const sonicMaps = parseMapTables(rd('Sonic_map.asm').toString());
const sonicDplc = parseDplcTables(rd('Sonic_dplc.asm').toString());
const knuxMap  = parseMapTables(rd('Knux_Cutscene_map.asm').toString()).Map_CutsceneKnux;
const knuxDplc = parseDplcTables(rd('Knux_Cutscene_dplc.asm').toString()).DPLC_CutsceneKnux;
const planeMap = Object.values(parseMapTables(rd('AIZ_IntroPlane_map.asm').toString()))[0];
const waveMap  = Object.values(parseMapTables(rd('AIZ_IntroWaves_map.asm').toString()))[0];
const emerMap  = Object.values(parseMapTables(rd('AIZ_IntroEmeralds_map.asm').toString()))[0];
const rockMap  = Object.values(parseMapTables(rd('AIZ_CorkFloor_map.asm').toString()))[0];
const sonicArt = rd('Sonic.unc'), knuxArt = rd('Knux_Cutscene.unc');
const planeArt = kosMDecode(rd('AIZ_IntroPlane.kosm'));
const emerArt  = kosMDecode(rd('AIZ_IntroEmeralds.kosm'));
const waveArt  = nemDecode(rd('AIZ_IntroWaves.nem'));

// DPLC frames load runs of tiles into the object's VRAM slot; mapping tiles
// index into what was loaded. Sonic_Load_PLC packs (count-1)<<12 | tile;
// Perform_DPLC (Knuckles) packs tile<<4 | (count-1).
function dplcArt(src, entries, sonicStyle){
  const parts = entries.map(e => {
    const [n, t] = sonicStyle ? [(e >> 12) + 1, e & 0xFFF] : [(e & 15) + 1, e >> 4];
    return src.subarray(t*32, (t+n)*32);
  });
  return Buffer.concat(parts);
}

const SPRITES = [], spriteIds = new Map();
function sprite(key, make){
  if(!spriteIds.has(key)){
    const f = make();
    spriteIds.set(key, f ? SPRITES.length : -1);
    if(f) SPRITES.push({key, ...f});
  }
  return spriteIds.get(key);
}
const sonicFrame = (table, f) => sprite(`${table}:${f}`, () =>
  renderFrame(sonicMaps[table][f], dplcArt(sonicArt, sonicDplc[table === 'Map_Sonic' ? 'PLC_Sonic' : 'PLC_SuperSonic'][f], true)));
const knuxFrame = (f, flip) => sprite(`knux:${f}:${+flip}`, () =>
  renderFrame(knuxMap[f], dplcArt(knuxArt, knuxDplc[f], false), {line: 1, hflip: flip}));
const planeFrame = f => sprite(`plane:${f}`, () => renderFrame(planeMap[f], planeArt));
const waveFrame  = f => sprite(`wave:${f}`,  () => renderFrame(waveMap[f], waveArt, {hflip: true}));
const emerFrame  = f => sprite(`emer:${f}`,  () => renderFrame(emerMap[f], emerArt, {line: 3}));
// Map_AIZCorkFloor at make_art_tile($001,2,0): level tiles from 1, line 2.
const rockFrame  = () => sprite('rock', () => renderFrame(rockMap[0], vram, {base: 1, line: 2}));
// BreakObjectToPieces: each piece of frame 1 its own object, art_tile | high_priority.
const rockPiece  = i => sprite(`rock:${i}`, () => renderFrame([rockMap[1][i]], vram, {base: 1, line: 2, pri: 1}));

// ---- palettes ---------------------------------------------------------------
const palSonic = words(rd('Pal_SonicTails.bin')).slice(0, 16);
const palIntro = words(rd('AIZ_Pal_Intro.bin'));                 // lines 2-4
const palMain  = words(rd('AIZ_Pal_Main.bin'));
const palEmer  = words(rd('AIZ_Pal_IntroEmeralds.bin'));
const palKnux  = words(rd('Knux_Cutscene_Pal.bin'));
if(palIntro.length !== 48 || palMain.length < 48) throw new Error('unexpected AIZ palette sizes');
// Tables that live in the code rather than in data files (sonic3k.asm L3985-4040, L4865).
const PalAIZ1_1 = [0xEE8,0xEE2,0xEA4,0xE64, 0xEE2,0xEA4,0xE64,0xEE8, 0xEA4,0xE64,0xEE8,0xEE2, 0xE64,0xEE8,0xEE2,0xEA4];
const PalAIZ1_3 = [0xEEC,0xEEE,0xEE8,0xE40, 0xEEC,0xEE8,0xEE8,0xEEE, 0xEEA,0xE86,0xEE8,0xEE8, 0xEE8,0xE40,0xEE8,0xE86,
                   0xEE6,0xEEE,0xEE8,0xE40, 0xEEA,0xEE8,0xEE8,0xEEE, 0xEE8,0xE86,0xEE8,0xEE8, 0xEE8,0xE40,0xEE8,0xE86,
                   0xEE6,0xEEE,0xEE8,0xE40, 0xEE8,0xEE8,0xEE8,0xEEE];
const PalAIZ1_4 = [0xCEC,0xCEE,0xEEE, 0xCEE,0xEEE,0xEEE, 0xEEE,0xEEE,0xEEE, 0xEEE,0xEEE,0xEEE, 0xEEE,0xEEE,0xEEE,
                   0xEEE,0xEEE,0xEEE, 0xEEE,0xEEE,0xEEE, 0xEE8,0xEEE,0xEEE, 0xEE8,0xEE8,0xEEE, 0xEE8,0xEE8,0xEE8];
// AnPal_PalAIZ1_2, followed by the start of AnPal_PalAIZ2_1: the counter can be
// left at $36 by the intro branch, and the read overruns into it once.
const PalAIZ1_2 = [0xEA4,0xE60,0xEE2, 0xEA4,0xEE8,0xEA4, 0xE60,0xEE8,0xEEE, 0xE60,0xEE2,0xEE2,
                   0xEE8,0xEA4,0xEA4, 0xEE2,0xE60,0xE60, 0xEE2,0xE60,0xEEE, 0xEE2,0xE60,0xEE8,
                   0xEE8,0xEE2,0xEC4,0xEA4, 0xEE2,0xEC4,0xEA4,0xEE8];
const SUPER = [[0xE66,0xC42,0x822],[0xE88,0xC66,0x844],[0xEAA,0xC88,0xA66],[0xECC,0xEAA,0xC88],[0xEEE,0xECC,0xEAA],
               [0xEEE,0xEEE,0xEEE],[0xCEE,0xCEE,0xAEE],[0xAEE,0x8EE,0x6CC],[0x8EE,0x0EE,0x0AA],[0xAEE,0x8EE,0x6CC]];

// ---- the simulation -----------------------------------------------------------
// A port of a line-by-line transcription of the routines; see the README for
// the timeline it produces. Positions are 16.16 fixed point; velocities 8.8.
class Obj {
  constructor(x, y){ this.x = x*65536; this.y = y*65536; this.xv = 0; this.yv = 0; this.alive = true; }
  get X(){ return s16(Math.floor(this.x / 65536)); }
  get Y(){ return s16(Math.floor(this.y / 65536)); }
  setX(v){ this.x = s16(v)*65536 + (this.x - Math.floor(this.x/65536)*65536); }
  setY(v){ this.y = s16(v)*65536 + (this.y - Math.floor(this.y/65536)*65536); }
}
const move2 = o => { o.x += o.xv*256; o.y += o.yv*256; };                                  // MoveSprite2
const move  = o => { o.x += o.xv*256; const old = o.yv; o.yv += 0x38; o.y += old*256; return old; }; // MoveSprite
function swing(o){                                                                         // Swing_UpAndDown
  let d = o.yv;
  if(!o.b0){ d -= o.acc; if(d > -o.mx){ o.yv = d; return; } o.b0 = true; }
  d += o.acc;
  if(d < o.mx){ o.yv = d; return; }
  o.b0 = false; o.yv = d - o.acc;
}
// Animate_Raw / Animate_RawNoSST over Knuckles' scripts, laid out contiguously
// as they are in the ROM, since a leftover index can read across them.
const K_ANIM = [1,0x12,0x13,0x14,0x15,0xFC, 1,8,4,8,5,8,6,8,7,0xFC, 7,0x1C,0x1C,0x1D,0xF8,6, 7,0x1E,0x1F,0xFC];
function animRaw(o){
  if(--o.at >= 0) return;
  const v = K_ANIM[o.base + 1 + ++o.ai];
  if(v < 0x80){ o.at = K_ANIM[o.base]; o.mf = v; return; }
  if(v === 0xFC){ o.mf = K_ANIM[o.base+1]; o.at = K_ANIM[o.base]; o.ai = 0; return; }
  if(v === 0xF8){ o.base += K_ANIM[o.base + 2 + o.ai]; o.mf = K_ANIM[o.base+1]; o.at = K_ANIM[o.base]; o.ai = 0; }
}
const BALL = [0x97,0x96,0x98,0x96,0x99,0x96,0x9A,0x96];               // byte_67A84
const WAVE = [0,1, 0,0, 1,1, 2,2, 3,2, 4,1, 5,1, 0xF4];               // byte_67A9B, (frame,delay) pairs
const PROP_A = [2,3,4,3,2,1], PROP_B = [6,5];                         // byte_67A8F, byte_67A97 as shown
const EMER_VEL = [[-0x40,-0x700],[-0x80,-0x700],[-0x180,-0x700],[-0x100,-0x700],[-0x200,-0x700],[-0x280,-0x700],[-0x300,-0x700]];
const ROCK_VEL = [[-0x100,-0x200],[0x100,-0x200],[-0xE0,-0x1C0],[0xE0,-0x1C0],[-0xC0,-0x180],[0xC0,-0x180],
                  [-0xA0,-0x140],[0xA0,-0x140],[-0x80,-0x100],[0x80,-0x100],[-0x60,-0xC0],[0x60,-0xC0]]; // word_2A8B0
const CAM_Y = 0x390;

let ev1 = (0xE918 + 8) & 0xFFFF;          // Events_fg_1 after P's init frame
let px = 0x40;                            // Player_1 x while hidden; y stays $420
const PY = 0x420;
let camX = 0, camMin = 0, resize = 0, cycFlag = 1;
const P = Object.assign(new Obj(0x60, 0x30), {r: 2, w2E: 0x40, w40: 8, b38: new Set(), b0: false,
                                              frame: ['Map_Sonic', 0xBA], at: 0, af: 0, w3A: 0});
let plane = null, knux = null, rock = null, PL = null, deleted = false;
const waves = [], emer = [], pieces = [];
const events = [];
const ev = (f, s) => events.push(`F${f}: ${s}`);

function spawnWave(f){ waves.push(Object.assign(new Obj(P.X, P.Y + 0x18), {born: f, ai: 0, at: 0, mf: 0})); }
function waitP(){ return --P.w2E < 0; }                                 // Obj_Wait
function waveTick(f){
  if(waitP()){ P.w2E = 5; if((P.X & 0xFFFF) >= 0x80) spawnWave(f); }
}
function stepP(f){
  switch(P.r){
    case 2:
      if(waitP()){
        P.r = 4; P.xv = 0x300; P.yv = 0x600;
        plane = Object.assign(new Obj(P.X - 0x22, P.Y + 0x2C), {yv: 0xC0, mx: 0xC0, acc: 0x10, b0: false, mode: 'attached', born: f});
        ev(f, 'the Tornado flies in');
      }
      break;
    case 4:
      P.yv -= 0x18;
      if(P.yv === 0){ P.r = 6; P.xv = 0; P.w2E = 0x5F; P.yv = 0xC0; P.mx = 0xC0; P.acc = 0x10; P.w40 = 0x10; P.b0 = false; }
      else move2(P);
      break;
    case 6:
      swing(P); move2(P);
      if(waitP()){ P.r = 8; P.xv = 0x400; P.yv = -0x400; P.b38.add(3); P.at = 0; P.af = 0; ev(f, 'Sonic jumps off'); }
      break;
    case 8:
      P.xv -= 0x40; move(P);
      if(P.Y >= 0x130){ P.r = 0xA; P.y = 0x130*65536; P.yv = 0; }
      else if(--P.at < 0){ P.at = 3; P.af = (P.af + 1) % 8; P.frame = ['Map_Sonic', BALL[P.af]]; }
      break;
    case 0xA:
      P.xv -= 0x40; move2(P);
      if((P.X & 0xFFFF) < 0x40){ P.r = 0xC; P.setX(0x40); P.w2E = 5; P.w3A = 0x3F; P.frame = ['Map_SuperSonic', 0x21]; ev(f, 'Super Sonic (off-screen)'); }
      break;
    case 0xC:
      if(--P.w3A < 0) P.r = 0xE;
      break;
    case 0xE: case 0x10: case 0x12: case 0x14:
      waveTick(f);
      if(P.r === 0xE){ P.setX(P.X + 4); if((P.X & 0xFFFF) >= 0x200){ P.r = 0x10; P.w3A = 0x1F; } }
      else if(P.r === 0x10){ if(--P.w3A < 0){ P.r = 0x12; P.b38.add(2); P.w40 = 0xC; } }
      else if(P.r === 0x12){ P.setX(P.X - 4); if((P.X & 0xFFFF) <= 0x120){ P.r = 0x14; P.w3A = 0x1F; P.w40 = 0x10; } }
      else if(--P.w3A < 0) P.r = 0x16;
      break;
    case 0x16:
      if(px >= 0x918){
        P.r = 0x18;
        knux = Object.assign(new Obj(0x1400, 0x440), {r: 2, mf: 8, at: 0, ai: 0, flip: false, base: 6, born: f});
        rock = Object.assign(new Obj(0x1400, 0x458), {born: f});
        ev(f, 'Knuckles is buried at ($1400,$440)');
      } else waveTick(f);
      break;
    case 0x18:
      if(px >= 0x1240){ P.r = 0x1A; P.setY(P.Y - 0x20); }
      break;
    case 0x1A:
      if(px >= 0x13D0){
        PL = Object.assign(new Obj(px, PY), {xv: -0x200, yv: -0x400, air: true, started: false, f0: f});
        EMER_VEL.forEach(([xv, yv], i) => emer.push(Object.assign(new Obj(px, PY), {sub: 2*i, xv, yv, state: 'fly'})));
        ev(f, 'knockback');
      }
      break;
  }
  if(P.r >= 0xE && P.r <= 0x1A) P.frame = ['Map_SuperSonic', (f >> 1) & 1 ? 0x22 : 0x21];   // sub_679B8
}
function stepPlane(f){
  if(!plane || !plane.alive) return;
  swing(plane); move2(plane);
  if(plane.mode === 'attached'){
    if(P.b38.has(2)) plane.mode = 'leaving';
    if(!P.b38.has(3)){ plane.setX(P.X - 0x22); plane.setY(P.Y + 0x2C); }
  } else {
    plane.setX(plane.X - 4);
    if((plane.X & 0xFFFF) < 0x20){ plane.alive = false; plane.died = f; }
  }
}
function stepWaves(f){
  for(const w of waves){
    if(!w.alive) continue;
    if((w.X & 0xFFFF) < 0x60){ w.alive = false; continue; }
    w.setX(w.X - P.w40);
    if(--w.at < 0){
      w.ai += 2;
      if(WAVE[w.ai] === 0xF4){ w.alive = false; continue; }
      w.mf = WAVE[w.ai]; w.at = WAVE[w.ai + 1];
    }
    w.shown = f;
  }
}
function stepKnux(f){
  const k = knux;
  if(!k || !k.alive) return;
  if(k.r === 2){
    if(PL){ k.r = 4; k.yv = -0x600; k.xv = 0x80; k.base = 6; }
  } else if(k.r === 4){
    animRaw(k);
    const old = move(k);
    if(old >= 0){ const d = probe(k.X, k.Y + 0x13); if(d < 0){ k.setY(k.Y + d); k.r = 6; k.mf = 0x16; k.w2E = 0x7F; ev(f, 'Knuckles lands'); } }
  } else if(k.r === 6){
    if(--k.w2E < 0){
      k.r = 8; k.flip = !k.flip; k.base = 0; k.xv = -0x600; k.yv = 0; k.w2E = 0x29; k.then = 'reverse';
      animRaw(k); move2(k); k.w2E--;
    }
  } else if(k.r === 8){
    animRaw(k); move2(k);
    if(--k.w2E < 0){
      if(k.then === 'reverse'){ k.xv = -k.xv; k.flip = !k.flip; k.w2E = 0x29; k.then = 'stop'; }
      else { k.r = 0xA; k.mf = 0x1C; k.w2E = 0x3F; k.base = 16; k.at = 0; k.ai = 0; ev(f, 'Knuckles laughs'); }
    }
  } else if(k.r === 0xA){
    animRaw(k);
    if(--k.w2E < 0){ k.r = 0xC; k.base = 0; k.xv = 0x600; }
  } else if(k.r === 0xC){
    if(k.onscreen){ animRaw(k); move2(k); }
    else { k.alive = false; ev(f, 'Knuckles is gone: end of the cutscene'); }
  }
}
function stepEmeralds(f){
  for(const e of emer){
    if(!e.alive) continue;
    if(e.state === 'fly'){
      const old = move(e);
      if(old >= 0){ const d = probe(e.X, e.Y + 4); if(d < 0){ e.setY(e.Y + d); e.state = 'rest'; } }
    } else if(knux && knux.alive){
      const lo = (e.X - 8) & 0xFFFF;
      if(knux.X >= lo && knux.X < lo + 16){
        const v = e.sub & 2 ? -knux.xv : knux.xv;
        if(v >= 0){ e.alive = false; ev(f, `emerald ${e.sub/2} taken`); }
      }
    }
  }
}
function stepPlayer(f){
  if(!PL || !PL.started || !PL.air) return;
  move2(PL); PL.yv += 0x30;
  const a = Math.round(Math.atan2(PL.yv, PL.xv) / (2*Math.PI) * 256) & 0xFF;
  const q = (a - 0x20) & 0xC0;
  if((q === 0x00 || q === 0x40) && PL.yv >= 0){
    const d1 = probe(PL.X + 9, PL.Y + 0x13), d2 = probe(PL.X - 9, PL.Y + 0x13);
    const dmin = Math.min(d1, d2), dmax = Math.max(d1, d2);
    let land = false;
    if(dmin < 0){
      if(q === 0x40) land = true;
      else { const thr = -(((PL.yv >> 8) & 0xFF) + 8); land = dmin >= thr || dmax >= thr; }
    }
    if(land){ PL.setY(PL.Y + dmin); PL.air = false; PL.xv = PL.yv = 0; PL.landed = f; ev(f, 'Sonic lands'); }
  }
  const nx = s16(Math.floor((PL.x + PL.xv*256) / 65536));
  if(nx < camMin + 0x10){ PL.setX(camMin + 0x10); PL.xv = 0; }
}
function stepPieces(f){
  for(const p of pieces){
    if(!p.alive || p.start > f) continue;
    move2(p); p.yv += 0x18;                                    // loc_2A5F8
    if(!p.onscreen) p.alive = false;
  }
}
function camera(){
  const x = PL ? PL.X : px;
  let d = x - camX - 0x90;
  if(d < 0){ camX = Math.max(camX + Math.max(d, -0x18), camMin); }
  else if((d -= 0x10) >= 0) camX = Math.min(camX + Math.min(d, 0x18), 0x6000);
  if(resize === 0){                                            // AIZ1_Resize
    if(camX >= 0x1000){
      cycFlag = 0; camMin = camX;
      if(camX >= 0x1308){ resize = 2; return 'aiz-palette'; }
    }
  } else camMin = 0x1308;
  return null;
}

// palette state
const pal = new Array(64).fill(0);
palSonic.forEach((c, i) => pal[i] = c);
let c1 = 0, c0 = 0, cc2 = 0, cc0 = 0, pTimer = 0, pFrame = 0x24, sStat = 0;
function palFade(){                                           // Pal_FromBlack over lines 2-4
  for(let i = 16; i < 64; i++){
    const cur = pal[i], tgt = palIntro[i-16];
    if(cur === tgt) continue;
    if(cur + 0x200 <= tgt) pal[i] = cur + 0x200;
    else if(cur + 0x20 <= tgt) pal[i] = cur + 0x20;
    else pal[i] = cur + 2;
  }
}
function palCycle(f){                                         // Animate_Palette, before the objects
  if(f <= 22){ palFade(); return; }
  if(sStat === 2 && --pTimer < 0){                             // SuperHyper_PalCycle_Revert
    pTimer = 3; const d = pFrame; pFrame -= 6;
    if(pFrame < 0){ sStat = 0; pFrame = 0; }
    SUPER[d/6].forEach((c, i) => pal[2+i] = c);
  }
  if(--c1 >= 0) return;
  if(cycFlag){                                                 // AnPal_AIZ1, intro branch
    c1 = 9; const d = c0; c0 += 8; if(c0 >= 0x50) c0 = 0;
    for(let i = 0; i < 4; i++) pal[48 + 2 + i] = PalAIZ1_3[d/2 + i];
    const e = cc2; cc2 += 6; if(cc2 >= 0x3C) cc2 = 0;
    for(let i = 0; i < 3; i++) pal[48 + 0xD + i] = PalAIZ1_4[e/2 + i];
  } else {                                                     // normal branch
    c1 = 7; const d = c0 & 0x18; c0 += 8;
    for(let i = 0; i < 4; i++) pal[32 + 0xB + i] = PalAIZ1_1[d/2 + i];
    if(!cc0){
      const e = cc2; cc2 += 6; if(cc2 >= 0x30) cc2 = 0;
      for(let i = 0; i < 3; i++) pal[48 + 0xC + i] = PalAIZ1_2[e/2 + i];
    }
  }
}
function superCycle(){                                        // sub_679B8's palette half
  if(--pTimer >= 0) return;
  pTimer = 6; const d = pFrame; pFrame += 6; if(pFrame >= 0x36) pFrame = 0x24;
  SUPER[d/6].forEach((c, i) => pal[2+i] = c);
}

// ---- run it --------------------------------------------------------------------
// Painter's order: Render_Sprites emits priority buckets front to back and, in a
// bucket, objects in slot order, and the first sprite emitted wins -- so draw the
// highest bucket first and, within one, the latest slot first.
const timeline = [];
let F;
for(F = 1; F < 1400; F++){
  palCycle(F);
  stepPlayer(F);
  if(!deleted){
    const before = P.r;
    stepP(F);
    if(P.r >= 0xE && P.r <= 0x1A) superCycle();
    if(ev1 & 0x8000) ev1 = (ev1 + P.w40) & 0xFFFF;              // sub_67A08
    else px += P.w40;
    if(PL && !PL.started){
      // P still pushed the player this frame, then is deleted (Go_Delete_Sprite)
      deleted = true; PL.setX(px); for(const e of emer) e.setX(px);
      pal.splice(48, 16, ...palEmer);                          // Pal_AIZIntroEmeralds -> line 4
      cc0 = 0xFF; sStat = 2; pFrame = 0x1E;
      P.lastFrame = F;
    }
    void before;
  }
  stepPlane(F);
  stepWaves(F);
  const kBefore = knux && knux.r;
  stepKnux(F);
  if(knux && kBefore === 2 && knux.r === 4) pal.splice(16, 16, ...palKnux);   // Pal_CutsceneKnux -> line 2
  // the rock watches Knuckles' status bit: frame 1's pieces fly the same frame
  if(rock && rock.alive && knux && knux.r !== 2){
    rock.alive = false;
    rockMap[1].forEach((_, i) => pieces.push(Object.assign(new Obj(rock.X, rock.Y),
      {i, xv: ROCK_VEL[i][0], yv: ROCK_VEL[i][1], start: i ? F : F + 1, onscreen: true})));
  }
  stepPieces(F);
  stepEmeralds(F);
  if(camera() === 'aiz-palette') pal.splice(16, 48, ...palMain.slice(0, 48)); // LoadPalette_Immediate(PalID_AIZ)
  if(PL && !PL.started) PL.started = true;
  if(knux && knux.alive){ const sx = knux.X - camX; knux.onscreen = sx + 0x1C >= 0 && sx - 0x1C < 320; }
  if(knux && !knux.alive) break;

  // ---- what is on screen this frame ----
  const spr = [];
  const add = (id, sx, sy, bucket, slot) => { if(id >= 0) spr.push({id, sx, sy, bucket, slot}); };
  const scr = (o, id, bucket, slot) => add(id, o.X - 0x80, o.Y - 0x80, bucket, slot);
  const wld = (o, id, bucket, slot) => add(id, o.X - camX, o.Y - CAM_Y, bucket, slot);
  if(!deleted || P.lastFrame === F) scr(P, sonicFrame(...P.frame), 5, 10);
  if(plane && plane.alive && F > plane.born){
    scr(plane, planeFrame(0), 5, 11);
    const k = F - plane.born - 1;
    add(planeFrame(PROP_A[k % 6]), plane.X + 0x38 - 0x80, plane.Y + 4 - 0x80, 5, 12);
    add(planeFrame(PROP_B[k % 2]), plane.X + 0x18 - 0x80, plane.Y + 0x18 - 0x80, 5, 13);
  }
  waves.forEach((w, i) => { if(w.alive && w.shown === F) scr(w, waveFrame(w.mf), 2, 20 + i); });
  if(knux && knux.alive) wld(knux, knuxFrame(knux.mf, knux.flip), 3, 11);
  if(rock && rock.alive) wld(rock, rockFrame(), 3, 12);
  emer.forEach((e, i) => { if(e.alive) wld(e, emerFrame(i), 5, 13 + i); });
  if(PL){
    // anim $1A (frame $8D) through the knock-back; walk frame 7 on the landing
    // frame; then AniSonic05's $BA, behind Sonic_Display's 4-on/4-off flicker
    let frame = 0x8D, show = F > PL.f0;
    if(PL.landed === F) frame = 7;
    else if(PL.landed && F > PL.landed){
      frame = 0xBA;
      const t = 120 - (F - PL.landed - 1);
      if(t > 0) show = (t & 4) !== 0;
    }
    if(show) wld(PL, sonicFrame('Map_Sonic', frame), 2, 0);
  }
  pieces.forEach(p => {
    if(!p.alive || p.start > F) return;
    const id = rockPiece(p.i), s = SPRITES[id];
    const sx = p.X - camX + s.ox, sy = p.Y - CAM_Y + s.oy;
    p.onscreen = sx + s.w > 0 && sx < 320 && sy + s.h > 0 && sy < 224;
    wld(p, id, p.i ? 0 : 1, 30 + p.i);
  });
  spr.sort((a, b) => b.bucket - a.bucket || b.slot - a.slot);
  timeline.push({f: F, cam: camX, bg: s16(ev1 & 0x8000 ? ev1 : camX), pal: pal.slice(),
                 spr: spr.map(s => [s.id, s.sx, s.sy])});
}
const LAST = F - 1;
for(const e of events) console.log('  ' + e);
if(emer.some(e => e.alive)) throw new Error('not every emerald was collected -- the simulation has drifted');
console.log(`  ${timeline.length} frames, F1-F${LAST}; ${SPRITES.length} distinct sprite frames`);

// ---- planes ---------------------------------------------------------------------
// Plane A only over the camera's path; it is empty (chunk 0) below x $900.
const cams = timeline.map(t => t.cam);
let fgX0 = Math.min(...cams), fgX1 = Math.max(...cams) + 320;
{
  const probeFg = renderPlane(false, fgX0, CAM_Y, fgX1 - fgX0, 224);
  let first = 0; while(first < fgX1 - fgX0 && ![...Array(224)].some((_, y) => probeFg.lo[y*(fgX1-fgX0)+first] || probeFg.hi[y*(fgX1-fgX0)+first])) first++;
  fgX0 += first & ~7;
}
const fg = renderPlane(false, fgX0, CAM_Y, fgX1 - fgX0, 224);

// AIZ1_IntroDeform: band 0 (80 sky lines) at d0 = v/2, then 36 bands of 4 lines
// interpolating towards $580 -- lower lines further, a perspective ocean.
function bands(v){
  const d0 = v >> 1, e = new Array(37);
  if(d0 >= 0x580) return e.fill(d0);
  e[0] = d0;
  let acc = ((d0 - 0x580) & 0xFFFF) << 16;                     // int32, low word 0
  const step = acc >> 5;
  for(let i = 1; i <= 36; i++){ acc = (acc + step) | 0; e[i] = s16(acc >> 16) + 0x580; }
  return e;
}
// Negative scroll positions read the 512-px plane as init drew it, BG x 0-$1FF.
let bgX1 = 512;
for(const t of timeline) for(const e of bands(t.bg)) if(e >= 0) bgX1 = Math.max(bgX1, e + 320);
bgX1 = (bgX1 + 7) & ~7;
const bg = renderPlane(true, 0, CAM_Y, bgX1, 224);
if(bg.hi.some(v => v)) throw new Error('plane B has high-priority tiles on screen; the page draws it as one layer');

// AnimateTiles_AIZ1 starts writing tiles $2E6-$303 at F755. Make sure none of
// them are in what the camera can see from then on, or they would need frames.
{
  const late = timeline.filter(t => t.f >= 755);
  const lo = Math.min(...late.map(t => t.cam)), hi = Math.max(...late.map(t => t.cam)) + 320;
  const seen = [['plane A', renderPlane(false, lo, CAM_Y, hi - lo, 224).tiles]];
  for(const t of late) for(const e of new Set(bands(t.bg))){
    const x = e < 0 ? 0 : e;
    seen.push(['plane B', renderPlane(true, x, CAM_Y, e < 0 ? 512 : 320, 224).tiles]);
  }
  for(const [name, set] of seen)
    for(const t of set) if(t >= 0x2E6 && t <= 0x303) throw new Error(`${name} shows animated tile $${t.toString(16)} after F755`);
}

// ---- write --------------------------------------------------------------------
// Index layers: grey g*4 for palette index g, index 0 transparent.
const KEY = Array.from({length: 64}, (_, g) => [g*4, g*4, g*4]);
function writeIdx(file, px, w, h){
  fs.writeFileSync(OUT + file, encodeIndexedPng(px, w, h, KEY, 0));
  console.log(`${file.padEnd(16)} ${String(w).padStart(4)}x${h}  ${String(fs.statSync(OUT + file).size).padStart(6)}B`);
}
writeIdx('aiz-fg.png', fg.lo, fgX1 - fgX0, 224);
writeIdx('aiz-fg-hi.png', fg.hi, fgX1 - fgX0, 224);
writeIdx('aiz-bg.png', bg.lo, bgX1, 224);

// Shelf-pack the sprite frames.
const AW = 512, order = SPRITES.map((s, i) => i).sort((a, b) => SPRITES[b].h - SPRITES[a].h);
let ax = 0, ay = 0, shelf = 0;
for(const i of order){
  const s = SPRITES[i];
  if(ax + s.w > AW){ ax = 0; ay += shelf; shelf = 0; }
  s.ax = ax; s.ay = ay; ax += s.w; shelf = Math.max(shelf, s.h);
}
const AH = ay + shelf, atlas = new Uint8Array(AW*AH);
for(const s of SPRITES) for(let y = 0; y < s.h; y++) atlas.set(s.px.subarray(y*s.w, (y+1)*s.w), (s.ay + y)*AW + s.ax);
writeIdx('aiz-sprites.png', atlas, AW, AH);

// The palettes it went through, and which one each frame showed.
const palKey = p => p.map(c => c.toString(16).padStart(3, '0')).join('');
const pals = [], palIdx = new Map();
for(const t of timeline){ const k = palKey(t.pal); if(!palIdx.has(k)){ palIdx.set(k, pals.length); pals.push(k); } t.p = palIdx.get(k); }

// The last frame, composited, is the still.
function composite(t){
  const out = new Uint8Array(320*224), e = bands(t.bg);
  out.fill(32);                                                 // backdrop: VDP $8720, line 2 colour 0
  for(let y = 0; y < 224; y++){
    const off = e[y < 80 ? 0 : 1 + ((y - 80) >> 2)];
    for(let x = 0; x < 320; x++){
      let X = x + off; if(X < 0) X = ((X % 512) + 512) % 512;
      const v = bg.lo[y*bgX1 + X]; if(v) out[y*320 + x] = v;
    }
  }
  const W = fgX1 - fgX0;
  const plane = layer => { for(let y = 0; y < 224; y++) for(let x = 0; x < 320; x++){
    const X = x + t.cam - fgX0; if(X < 0 || X >= W) continue;
    const v = layer[y*W + X]; if(v) out[y*320 + x] = v; } };
  const sprites = hi => { for(const [id, sx, sy] of t.spr){ const s = SPRITES[id]; if(s.hi !== hi) continue;
    for(let y = 0; y < s.h; y++) for(let x = 0; x < s.w; x++){
      const v = s.px[y*s.w + x], X = sx + s.ox + x, Y = sy + s.oy + y;
      if(v && X >= 0 && X < 320 && Y >= 0 && Y < 224) out[Y*320 + X] = v; } } };
  plane(fg.lo); sprites(0); plane(fg.hi); sprites(1);
  return out;
}
const last = timeline[timeline.length - 1];
const lastPal = last.pal.map(w => [((w >> 1) & 7)*36, ((w >> 5) & 7)*36, ((w >> 9) & 7)*36]);
fs.writeFileSync(OUT + 'aiz-still.png', encodeIndexedPng(composite(last), 320, 224, lastPal, -1));
console.log(`aiz-still.png     320x224  ${fs.statSync(OUT + 'aiz-still.png').size}B`);

// Per-frame series, run-length coded: [value, count, ...].
const rle = a => { const o = []; for(const v of a){ if(o.length && o[o.length-2] === v) o[o.length-1]++; else o.push(v, 1); } return o; };
const meta = {
  len: timeline.length, fgX0, camY: CAM_Y,
  sprites: SPRITES.map(s => [s.ax, s.ay, s.w, s.h, s.ox, s.oy, s.hi]),
  pals, pal: rle(timeline.map(t => t.p)),
  cam: rle(timeline.map(t => t.cam)), bg: rle(timeline.map(t => t.bg)),
  spr: timeline.map(t => t.spr.flat()),
};
fs.writeFileSync(OUT + 'aiz-meta.json', JSON.stringify(meta));
console.log(`aiz-meta.json     ${fs.statSync(OUT + 'aiz-meta.json').size}B  ${pals.length} palettes`);
