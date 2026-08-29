/* Builds every S&K title asset the page embeds, from the disassembly's own data.
   Run it with:  node tools/build-sk-assets.mjs [outDir]
   Default outDir is tools/out/. Nothing here ships in index.html except the
   finished PNGs, which are pasted in as base64 -- see tools/README.md.

   Four stages that used to be separate throwaway scripts, folded together so
   there are no intermediate files to keep in sync:
     1. Kosinski / moduled Kosinski for the tile art
     2. the runtime hand DMAs patched over the standing art
     3. Enigma for the plane tilemaps
     4. compose the layers, crop, and write indexed PNGs + intro-meta.json  */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {kosDecode, kosMDecode} from './lib/kosinski.mjs';
import {eniDecode} from './lib/enigma.mjs';
import {encodeIndexedPng} from './lib/png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D    = path.join(HERE, 'rom') + path.sep;
const OUT  = (process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, 'out')) + path.sep;
fs.mkdirSync(OUT, {recursive: true});

// ---- 1. tile art -----------------------------------------------------------
const bgArt   = kosDecode(fs.readFileSync(D+'SK_BG.kos')).data;
const skArt   = kosMDecode(fs.readFileSync(D+'SK_SonicKnux.kosm'));
const landArt = kosMDecode(fs.readFileSync(D+'SK_SonicLand.kosm'));
const hands   = kosDecode(fs.readFileSync(D+'SK_Hands.kos')).data;
const deArt   = kosDecode(fs.readFileSync(D+'SK_DeathEgg.kos')).data;
const mtArt   = kosDecode(fs.readFileSync(D+'SK_Mountain.kos')).data;
const fallArt = kosDecode(fs.readFileSync(D+'SK_SonicFall.kos')).data;
for(const [name, a] of [['background',bgArt],['sonic+knux',skArt],['landing',landArt],
                        ['hands',hands],['death egg',deArt],['mountain',mtArt],['fall',fallArt]])
  if(a.length % 32) throw new Error(name + ': not tile-aligned (' + a.length + ' bytes)');

// ---- 2. Knuckles' face and fists are placeholders in the blob ---------------
// Obj_SKTitle_HandAnim DMAs over them at runtime; without replaying those four
// writes you get leftover garbage across his chest.
for(const [ram,tile,words] of [[0x4800,1,0x30],[0x4E40,4,0x290],[0x5880,0x2D,0x2F0],[0x6A20,0x5C,0x140]])
  skArt.set(hands.subarray(ram-0x4800, ram-0x4800+words*2), tile*32);

// ---- 3. plane tilemaps -----------------------------------------------------
const SK = 0xE2, LAND = SK + skArt.length/32;
const bgmap = eniDecode(fs.readFileSync(D+'SK_BG.eni'), 0x0000);
const fmaps = [1,2,3,4].map(n => eniDecode(fs.readFileSync(D+`SK_Frame${n}.eni`), 0x8000 | SK));
if(bgmap.length !== 40*28) throw new Error('bg map is ' + bgmap.length + ' words, expected 1120');

const tileByte=(t,y,x)=> t<SK?bgArt[t*32+y*4+(x>>1)] : t<LAND?skArt[(t-SK)*32+y*4+(x>>1)] : landArt[(t-LAND)*32+y*4+(x>>1)];
const praw=Buffer.concat([fs.readFileSync(D+'SK_Sonic.bin'),fs.readFileSync(D+'SK_Knux.bin'),
                          fs.readFileSync(D+'SK_SegaBG.bin').subarray(32,96)]);
const PAL=[]; for(let i=0;i<64;i++){const w=(praw[i*2]<<8)|praw[i*2+1];
  PAL.push([((w>>1)&7)*36,((w>>5)&7)*36,((w>>9)&7)*36]);}
const parseMap=f=>[...fs.readFileSync(D+f,'utf8').matchAll(/dc\.b\s+([^\n]+)/g)]
  .map(m=>m[1].split(',').map(t=>{t=t.trim();return t.startsWith('$')?parseInt(t.slice(1),16):parseInt(t,10);}));
const deMap=parseMap('SK_DeathEgg_map.asm'), mtMap=parseMap('SK_Mountain_map.asm'), fallMap=parseMap('SK_SonicFall_map.asm');

// ---- 4. compose ------------------------------------------------------------
const W=320,H=224,EMPTY=0xFF;
const newBuf=()=>new Uint8Array(W*H).fill(EMPTY);
function plane(px,map,opaque){
  for(let r=0;r<28;r++) for(let c=0;c<40;c++){
    const w=map[r*40+c],t=w&0x7FF,hf=(w>>11)&1,vf=(w>>12)&1,line=(w>>13)&3;
    for(let y=0;y<8;y++) for(let x=0;x<8;x++){
      const sx=hf?7-x:x, sy=vf?7-y:y;
      const b=tileByte(t,sy,sx), idx=(sx&1)?(b&0x0F):(b>>4);
      if(!idx&&!opaque) continue;
      px[(r*8+y)*W + c*8+x]=line*16+idx;
    }
  }
}
function sprite(px,map,art,objX,objY,line){
  for(const [yy,size,th,tl,xh,xl] of map){
    let Y=yy>127?yy-256:yy, X=(xh<<8)|xl; if(X>32767) X-=65536;
    const pw=((size>>2)&3)+1, ph=(size&3)+1, word=(th<<8)|tl;
    let t=word&0x7FF; const hf=!!(word&0x800), vf=!!(word&0x1000);
    const L = line !== undefined ? line : ((word>>13)&3);
    for(let cx=0;cx<pw;cx++) for(let cy=0;cy<ph;cy++){
      for(let y=0;y<8;y++) for(let x=0;x<8;x++){
        const sx=hf?7-x:x, sy=vf?7-y:y;
        const b=art[t*32+sy*4+(sx>>1)], idx=(sx&1)?(b&0x0F):(b>>4);
        if(!idx) continue;
        const gx=objX-128+X+(hf?(pw-1-cx):cx)*8+x, gy=objY-128+Y+(vf?(ph-1-cy):cy)*8+y;
        if(gx>=0&&gx<W&&gy>=0&&gy<H) px[gy*W+gx]=L*16+idx;
      } t++;
    }
  }
}
function bbox(px){ let x0=W,y0=H,x1=-1,y1=-1;
  for(let y=0;y<H;y++) for(let x=0;x<W;x++) if(px[y*W+x]!==EMPTY){
    if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; }
  return x1<0?null:{x:x0,y:y0,w:x1-x0+1,h:y1-y0+1}; }
function writeLayer(px,file,crop){
  const r=crop?bbox(px):{x:0,y:0,w:W,h:H};
  if(!r) throw new Error(file+': empty');
  const out=new Uint8Array(r.w*r.h), used=new Set();
  for(let y=0;y<r.h;y++) for(let x=0;x<r.w;x++){
    const v=px[(r.y+y)*W+r.x+x]; out[y*r.w+x]=v; if(v!==EMPTY) used.add(v); }
  const entries=[...used].sort((a,b)=>a-b);
  const transparent = crop || entries.length<64;
  const map=new Map(entries.map((v,i)=>[v,i+(transparent?1:0)]));
  const pal = transparent?[[0,0,0],...entries.map(v=>PAL[v])]:entries.map(v=>PAL[v]);
  const idx=Uint8Array.from(out,v=>v===EMPTY?0:map.get(v));
  fs.writeFileSync(file, encodeIndexedPng(idx,r.w,r.h,pal,transparent?0:-1));
  console.log(`${file.padEnd(18)} ${String(r.w).padStart(3)}x${String(r.h).padStart(3)} @${r.x},${r.y}  ${String(fs.statSync(file).size).padStart(6)}B  ${entries.length} col`);
  return r;
}
// --- ROM constants (Obj_SKTitle_*) ---
const EGG_X=0x140, EGG_Y0=0xB0, EGG_Y1=0xF0;      // descends 176 -> 240
const MTN_X=0x140, MTN_Y=0x1A8-0x100;               // $1A8 - camera; already screen-space, so no sprite() bias
const FALL_X=0xE8, FALL_Y1=0xF0;
// The egg lands at $F0, then Obj_SKTitle_DeathEggShake walks it up 0.5/frame
// while the camera finishes its own 128px -- settling at $F0-128 = $70, which
// is exactly the "proper position" the fast-forward path writes.
const EGG_SETTLED=0x70;

const meta={};
let px=newBuf(); plane(px,bgmap,true);
meta.back=writeLayer(px,OUT+'sk-back.png',false);
meta.front=[];
for(let i=0;i<4;i++){                               // character planes only -- during the
  px=newBuf();                                      // descent the ROM shows the SEGA logo
  plane(px,fmaps[i],false);                         // here, and these scroll in after landing
  meta.front.push(writeLayer(px,OUT+`sk-front${i+1}.png`,false));
}
px=newBuf(); sprite(px,mtMap,mtArt,MTN_X,MTN_Y,3);  // "top of the mountain is a sprite so it
meta.mountain=writeLayer(px,OUT+'sk-mtn.png',true);     //  can cover the Death Egg" -- drawn over it
px=newBuf(); sprite(px,deMap,deArt,EGG_X,EGG_Y1,2);
meta.egg=writeLayer(px,OUT+'sk-egg.png',true); meta.egg.anchorY=EGG_Y1;
px=newBuf(); sprite(px,fallMap,fallArt,FALL_X,FALL_Y1,0);
meta.sonic=writeLayer(px,OUT+'sk-fall.png',true); meta.sonic.anchorY=FALL_Y1;
// still = the state the intro ends in: egg landed at $F0, final character frame
px=newBuf(); plane(px,bgmap,true);
sprite(px,deMap,deArt,EGG_X,EGG_SETTLED,2);
sprite(px,mtMap,mtArt,MTN_X,MTN_Y,3);
plane(px,fmaps[3],false);
meta.still=writeLayer(px,OUT+'sk-still.png',false);
meta.eggSettled=EGG_SETTLED;
meta.cam1=0x100;
// geometry check: is the egg's base covered by the mountain sprite?
const eggPx=newBuf(); sprite(eggPx,deMap,deArt,EGG_X,EGG_Y1,2);
const mtPx=newBuf(); sprite(mtPx,mtMap,mtArt,MTN_X,MTN_Y,3);
const eb=bbox(eggPx), mb=bbox(mtPx);
let covered=0, exposedBelowMtnTop=0;
for(let y=0;y<H;y++) for(let x=0;x<W;x++){
  if(eggPx[y*W+x]===EMPTY) continue;
  if(mtPx[y*W+x]!==EMPTY) covered++;
  else if(mb && y>=mb.y) exposedBelowMtnTop++;
}
console.log('\negg bbox   ', JSON.stringify(eb));
console.log('mountain   ', JSON.stringify(mb));
console.log('egg px hidden by mountain sprite:', covered);
console.log('egg px below mountain top yet visible:', exposedBelowMtnTop);

// ---- idle hand animation (Obj_SKTitle_HandAnim) ----------------------------
// Four channels, each DMAing a run of tiles over the standing art. Every one has
// exactly three states a block apart, and one of them is what the scene already
// ships, so only the other two need to exist as overlays.
const HAND = [
  {name:'smile',  base:0x4800, tile:0x01, words:0x30,  dur:5, seq:[0,1,2], hold:true,  states:[0,3,6],    idle:0},
  {name:'finger', base:0x4920, tile:0x04, words:0x290, dur:3, states:[0,41,82], idle:1},
  {name:'knuck1', base:0x5880, tile:0x2D, words:0x2F0, dur:3, states:[0,47,94], idle:0},
  {name:'knuck2', base:0x6A20, tile:0x5C, words:0x140, dur:3, states:[0,20,40], idle:0},
];
// sequences straight out of the ROM tables, mapped onto state indices
const RAWSEQ = {
  finger: [41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,
           0,0,41,82,41,0,41,82,41,0,41,82,41],
  knuck1: [0,0,0,0,0,0,0,0,47,94,47,0,47,94,47],
  knuck2: [0,0,20,40,20,0,0],
};
for(const h of HAND){
  if(RAWSEQ[h.name]) h.seq = RAWSEQ[h.name].map(v => h.states.indexOf(v));
  if(h.seq.some(i => i < 0)) throw new Error(h.name + ': unmapped frame value');
}
const basePx = (()=>{ const b=newBuf(); plane(b,fmaps[3],false); return b; })();
meta.hands = HAND.map(h => {
  const out = {name:h.name, dur:h.dur, seq:h.seq, idle:h.idle, hold:!!h.hold, patches:[]};
  if(h.name === 'smile') out.delay = 3*60;      // move.b #3*60,$30(a0)
  for(let si = 0; si < h.states.length; si++){
    if(si === h.idle){ out.patches.push(null); continue; }
    const save = skArt.slice(h.tile*32, h.tile*32 + h.words*2);
    const off = h.base - 0x4800 + h.states[si]*32;
    skArt.set(hands.subarray(off, off + h.words*2), h.tile*32);
    const px = newBuf(); plane(px, fmaps[3], false);
    // keep only what this state actually changes
    const diff = newBuf();
    let n = 0;
    for(let i = 0; i < px.length; i++)
      if(px[i] !== basePx[i]){ diff[i] = px[i]; n++; }
    skArt.set(save, h.tile*32);                 // restore before the next state
    const r = writeLayer(diff, OUT+`sk-${h.name}${si}.png`, true);
    out.patches.push({file:`sk-${h.name}${si}.png`, x:r.x, y:r.y, w:r.w, h:r.h, px:n});
  }
  const period = h.hold ? 'one-shot' : h.dur*h.seq.length;
  console.log(`  ${h.name.padEnd(7)} ${h.seq.length} steps x ${h.dur}f = ${period}`);
  return out;
});

fs.writeFileSync(OUT+'intro-meta.json', JSON.stringify(meta,null,1));
const files=fs.readdirSync(OUT).filter(f=>f.endsWith('.png'));
console.log('\n' + files.length + ' assets, ' + files.reduce((a,f)=>a+fs.statSync(OUT+f).size,0) + ' bytes total');
