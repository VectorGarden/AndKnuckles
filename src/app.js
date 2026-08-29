const BG_W = 320, BG_H = 224;
const BG_SCROLL = 16;   // V_scroll_value climbs 1/frame to $10 to make room

const SPACE_W = 8;
// Both outlined defaults used to be negative, which merged neighbouring glyphs
// and rows into one continuous navy mass. The ROM's own "& KNUCKLES" bitmap is
// packed even tighter than that -- 168px against our 180 at -2 -- so the tight
// look is authentic, but it reads as overlap. 0 lets the outlines touch while
// each glyph and line stays its own; -3 or so reproduces the ROM spacing.
const DEFAULTS = { outline:{track:0, lead:0}, plain:{track:2, lead:4} };

const el = id => document.getElementById(id);
const canvas = el('preview'), ctx = canvas.getContext('2d');
const atlas = new Image();
let ready = false;

const SUP = { webp:true, avif:true };
const state = {
  text:'', style:'outline', scale:4, track:0, lead:0, pad:0, palette:'classic', tint:'#FCB400', linePalettes:[],
  align:'center', bg:'none', touchedTrack:false, touchedLead:false,
  mode:'still', timebase:'pal', scene:'off', sceneY:176, intro:true,
  dist:96, vel0:4, accel:0.25, damp:0.5, amp:100, head:-1
};

/* ---------- canvas limits ----------
   render() used to cap on pixel AREA only; browsers also cap each AXIS, so a
   long line at high scale produced a silently blank canvas. Cap on both. */
const MAX_DIM = 32767;
const STILL_BUDGET = 36e6;
const ANIM_BUDGET  = 1e6;   // animated frames multiply, so cap harder than stills

function clampScale(w0, h0, want, budget){
  let s = Math.max(1, want);
  while(s > 1 && (w0*s > MAX_DIM || h0*s > MAX_DIM || w0*s*h0*s > budget)) s--;
  return s;
}

/* ---------- layout ---------- */
function layout(){
  const font = FONT[state.style], G = font.glyphs;
  const raw = (state.text.trim() ? state.text : '& KNUCKLES').toUpperCase();
  const skipped = new Set();
  const lines = raw.split('\n').slice(0,12).map(src=>{
    const items=[]; let x=0;
    for(const ch of src){
      if(ch===' '){ x += SPACE_W + state.track; continue; }
      const g = G[ch];
      if(!g){ if(ch.trim()) skipped.add(ch); continue; }
      items.push({g,x});
      x += g[2] + state.track;
    }
    return {items, w: items.length ? x - state.track : 0};
  });
  const w = Math.max(1, ...lines.map(l=>l.w));
  const h = lines.length*font.rowh + (lines.length-1)*state.lead;
  return {lines, w, h:Math.max(1,h), rowh:font.rowh, skipped:[...skipped], ghost: !state.text.trim()};
}

/* ---------- draw ---------- */
/* Top-left of the text block in logical canvas coordinates. In scene mode the
   block sits where the ROM puts & KNUCKLES: horizontally centred in the 320px
   frame, vertically centred on sceneY (176 = banner rest $D4 + $5C, less the
   $80 sprite-space origin). */
function origin(L, G){
  if(G.scene) return { x: Math.round((BG_W - L.w)/2), y: Math.round(state.sceneY - L.h/2) };
  return { x: state.pad, y: G.head + state.pad };
}

function paint(target, scale, L, dy, G, scroll, frame){
  dy = dy||0; scroll = scroll||0;
  G = G || geom(L);
  const W = G.w0*scale, H = G.h0*scale;
  target.width = W; target.height = H;
  const c = target.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.clearRect(0,0,W,H);
  const img = sceneImg();
  if(G.scene && introOn()){
    // note: not L -- that is the text layout, and shadowing it here is how the
    // wrapper object ended up passed to drawImage instead of the image
    const IL = introLayers[state.scene], st = introState(frame||0);
    const bo = st.bgOff - st.shakeY, mo = st.mtnOff - st.shakeY;
    const put = (lay, ox, oy) => c.drawImage(lay.img, ox*scale, (oy - scroll)*scale,
                                             lay.w*scale, lay.h*scale);
    // Full-plane layer with its edge rows repeated into whatever the camera or
    // the V_scroll exposes -- sky above, land below. Mirrors blitLayer's clamp.
    const plane = (lay, oy) => {
      const top = oy - scroll, bot = top + lay.h;
      put(lay, 0, oy);
      if(top > 0) c.drawImage(lay.img, 0, 0, lay.w, 1,
                              0, 0, lay.w*scale, top*scale);
      if(bot < BG_H) c.drawImage(lay.img, 0, lay.h-1, lay.w, 1,
                                 0, bot*scale, lay.w*scale, (BG_H-bot)*scale);
    };
    plane(IL.back, bo);
    put(IL.egg, IL.egg.x, IL.egg.y + (st.eggY - IL.egg.anchorY) - st.shakeY);
    put(IL.mtn, IL.mtn.x, IL.mtn.y + mo);
    const slide = st.f ? 0 : Math.round((1 - st.reveal) * BG_H);
    if(st.reveal > 0){
      if(slide === 0) plane(IL.front[st.f], bo);
      else put(IL.front[st.f], 0, slide + bo);
    }
    const hs = handStates(frame||0);
    if(hs) hs.forEach((v, i) => {
      const q = IL.hands[i][v];
      if(q) put(q, q.x, q.y);
    });
    if(st.falling) put(IL.sonic, IL.sonic.x, IL.sonic.y + (st.sonicY - IL.sonic.anchorY));
  } else if(G.scene && img){
    c.drawImage(img, 0, -scroll*scale, BG_W*scale, BG_H*scale);
    if(scroll > 0)   // repeat the last row into the strip the scroll exposed
      c.drawImage(img, 0, BG_H-1, BG_W, 1, 0, (BG_H-scroll)*scale, BG_W*scale, scroll*scale);
  } else if(state.bg !== 'none'){
    c.fillStyle = state.bg; c.fillRect(0,0,W,H);
  }
  const o = origin(L, G);
  L.lines.forEach((line,i)=>{
    let ox = 0;
    if(state.align==='center') ox = Math.round((L.w - line.w)/2);
    if(state.align==='right')  ox = L.w - line.w;
    const oy = i*(L.rowh + state.lead);
    const atlasForLine = tintedAtlas(rampForLine(i));
    for(const {g,x} of line.items){
      c.drawImage(atlasForLine, g[0],g[1],g[2],g[3],
        (o.x + ox + x)*scale, (o.y + oy + g[4] + dy)*scale, g[2]*scale, g[3]*scale);
    }
  });
  return {W,H};
}

function geom(L){
  if(sceneOn()) return { head: 0, w0: BG_W, h0: BG_H, scene: true };
  const head = headroom();
  return { head, w0: L.w + state.pad*2, h0: L.h + state.pad*2 + head };
}
function scaleFor(L){
  const g = geom(L);
  return clampScale(g.w0, g.h0, state.scale,
                    state.mode === 'anim' ? ANIM_BUDGET : STILL_BUDGET);
}

/* Frame 0 of the spring is the text still off the bottom of the canvas, so a
   paused animated view parked there shows nothing. Rest is the readable pose:
   that is where the player sits whenever it is not running, and Play rewinds. */
const player = { playing:false, frame:0, raf:0, acc:0, last:0 };
// Rest is the last frame of the whole timeline, intro included -- using just the
// spring's length parked the preview mid-bounce and, because play() rewinds only
// from rest, left Play resuming past the intro so the opening never showed.
const restFrame = () => Math.max(0, motion().frames.length - 1
                                    + (introOn() ? introLen() : 0) + introTail());
function showRest(){ player.frame = restFrame(); }

function render(){
  if(!ready) return;
  const L = layout();
  const g = geom(L);
  const scale = scaleFor(L);
  const anim = state.mode === 'anim';
  const frames = anim ? motion().frames : null;
  const span = anim ? frames.length + (introOn() ? introLen() : 0) + introTail() : 0;
  if(anim && player.frame >= span) player.frame = 0;
  const iLen = anim && introOn() ? introLen() : 0;
  const dyNow = anim ? frames[Math.max(0, Math.min(frames.length-1, player.frame - iLen))] : 0;
  const {W,H} = paint(canvas, scale, L, dyNow, g,
                      scrollAt(anim ? player.frame : 1e9), player.frame);

  canvas.classList.toggle('ghost', L.ghost);
  el('dims').textContent = W + ' × ' + H + ' px';
  el('scaleOut').textContent = scale + '×' + (scale !== state.scale ? ' (capped)' : '');
  el('skipped').textContent = L.skipped.length ? '· skipped ' + L.skipped.join(' ') : '';
  renderLineRows();

  const has = !!state.text.trim();
  el('dlPng').disabled = !has;
  el('copy').disabled = !has;
  el('dlWebp').disabled = !has || !SUP.webp;
  el('dlAvif').disabled = !has || !SUP.avif;
  el('dlGif').disabled  = !has || !anim;
  el('dlApng').disabled = !has || !anim || !SUP_APNG;
  el('dlWebm').disabled = !has || !anim || !videoMime('webm');
  el('dlMp4').disabled  = !has || !anim || !videoMime('mp4');

  if(anim){
    const sc = el('scrub');
    sc.max = span - 1;
    sc.value = player.frame;
    el('frameOut').textContent = (player.frame+1) + '/' + span;
    const m = motion();
    el('romFlag').textContent = !m.settled ? 'never settles — loop jumps'
                              : isRomStock() ? 'ROM stock' : 'modified';
    el('romFlag').className = (!m.settled || !isRomStock()) ? 'warn' : 'ok';
    queueEstimate();
  }
}

/* ---------- playback ---------- */
const FRAME_MS = 20;                 // GIF delay is whole centiseconds: 2cs
function tick(ts){
  if(!player.playing) return;
  const frames = motion().frames;
  const total = frames.length + (introOn() ? introLen() : 0);
  if(player.last) player.acc += ts - player.last;
  player.last = ts;
  let stepped = false;
  while(player.acc >= FRAME_MS){
    player.acc -= FRAME_MS;
    player.frame = (player.frame + 1) % total;
    stepped = true;
  }
  if(stepped) render();
  player.raf = requestAnimationFrame(tick);
}
function play(){
  if(player.playing) return;
  if(player.frame >= restFrame()) player.frame = 0;   // replay from the top

  player.playing = true; player.last = 0; player.acc = 0;
  el('play').textContent = 'Pause';
  player.raf = requestAnimationFrame(tick);
}
function pause(){
  player.playing = false;
  cancelAnimationFrame(player.raf);
  el('play').textContent = 'Play';
}


/* ---------- ROM motion ----------------------------------------------------
   Ported from Obj_TitleBanner_Main, sonic3k.asm:6039 (sonicretro/skdisasm).
   The title banner is a damped spring, not an eased tween: position lives in a
   32-bit fixed-point accumulator, acceleration flips sign across rest, and the
   velocity is halved (asr) on every zero crossing. The "& KNUCKLES" subtitle
   has no motion of its own -- Obj_TitleANDKnuckles_Display welds it to
   banner_y + $5C -- so the whole block travels as one rigid body.

   With stock values this lands exactly on the ROM's own settle test
   (offset 0 and y_vel == -$5B) at frame 99, giving 100 frames.             */
const ROM = { dist:96, vel0:4, accel:0.25, damp:0.5 };
const SETTLE_VEL = -0x5B, MAX_FRAMES = 400, SETTLE_WIN = 16;

const s16 = v => { v &= 0xFFFF; return v & 0x8000 ? v - 0x10000 : v; };
const s32 = v => { v = v|0; return v; };

function springCurve(o){
  o = o || {};
  const dist  = o.dist  === undefined ? ROM.dist  : o.dist;
  const vel0  = o.vel0  === undefined ? ROM.vel0  : o.vel0;
  const accel = o.accel === undefined ? ROM.accel : o.accel;
  const damp  = o.damp  === undefined ? ROM.damp  : o.damp;
  const amp   = o.amp   === undefined ? 1 : o.amp;
  // stock ROM parameters -> use the ROM's exact terminating condition
  const isRom = dist===ROM.dist && vel0===ROM.vel0 && accel===ROM.accel && damp===ROM.damp;

  let acc = s32(-dist * 65536);      // $30(a0), init $FFA00000 when dist = 96
  let vel = s16(Math.round(vel0 * 256));  // y_vel, init $400 when vel0 = 4
  const d1base = Math.round(accel * 256); // ±$40 when accel = 0.25
  let flag = 0, done = false;
  const raw = [];                          // unscaled offsets, for the settle test

  for(let f = 0; f < MAX_FRAMES && !done; f++){
    const prev = flag;                       // move.b $34(a0),d2
    acc = s32(acc + s32(vel * 256));         // add.l d0,$30(a0)
    const hi = s16((acc >> 16) & 0xFFFF);    // move.w $30(a0),d0 -> high word
    flag = 0;
    let d1 = d1base;
    if(hi >= 0){
      // Stock parameters land exactly on the ROM's own test. Tuned parameters
      // may never hit it, so fall back to an envelope: once a whole window of
      // frames stays within a pixel of rest the motion is visually over. A
      // plain zero-run does not work -- damping near 0.7 dithers 0/-1 forever.
      if(isRom){
        if(hi === 0 && vel === s16(SETTLE_VEL)) done = true;
      }else if(raw.length >= SETTLE_WIN){
        let peak = Math.abs(hi);
        for(let i = raw.length - SETTLE_WIN; i < raw.length; i++)
          peak = Math.max(peak, Math.abs(raw[i]));
        if(peak <= 1) done = true;
      }
      if(!done){ flag = -1; d1 = -d1base; }  // loc_48AA
    }
    if(!done){
      vel = s16(vel + d1);                   // add.w d1,y_vel
      if(prev !== flag) vel = s16(Math.floor(vel * damp)); // asr y_vel
    }
    raw.push(hi);
  }

  if(!isRom && done){
    // close the loop cleanly on rest instead of on a 1px dither
    let end = raw.length;
    while(end > 1 && Math.abs(raw[end-1]) <= 1) end--;
    raw.length = Math.min(raw.length, end + 2);
    raw[raw.length-1] = 0;
  }
  const out = raw.map(v => Math.round(v * amp));
  out.settled = done;                        // false => hit the guard, loop will jump
  return out;
}

/* Screen delta from rest is -offset: +offset means higher up (smaller y). */
const curveCache = { key:'', frames:null, head:0 };
function motion(){
  const k = [state.dist,state.vel0,state.accel,state.damp,state.amp].join('|');
  if(curveCache.key !== k){
    const off = springCurve({
      dist:state.dist, vel0:state.vel0, accel:state.accel,
      damp:state.damp, amp:state.amp/100
    });
    curveCache.key = k;
    curveCache.frames = off.map(v => -v);          // -> downward pixel delta
    curveCache.head = Math.max(0, ...off);         // overshoot above rest
    curveCache.settled = off.settled;
  }
  return curveCache;
}
function headroom(){
  if(sceneOn()) return 0;           // the 320x224 frame is the viewport; clipping is authentic
  if(state.mode !== 'anim') return 0;
  return state.head < 0 ? motion().head : state.head;
}
function isRomStock(){
  return state.dist===ROM.dist && state.vel0===ROM.vel0 &&
         state.accel===ROM.accel && state.damp===ROM.damp && state.amp===100 &&
         (state.head < 0 || state.head === motion().head);
}

/* ---------- indexed atlas -------------------------------------------------
   The sheet is 7 opaque colours with no partial alpha (a real Genesis
   palette), so an indexed representation is lossless. GIF export needs it,
   and palette recolouring will reuse it.                                   */
let ATLAS_IDX = null, PALETTE = null, ATLAS_W = 0, ATLAS_H = 0;

/* The sheet is seven opaque colours, and they form a ramp with fixed roles:
   accent, face, shadow, specular, highlight, soft highlight, outline. Swapping
   those seven is the whole recolouring feature -- every glyph, both styles and
   every export path take their colours from PALETTE, so rewriting it in place
   is enough. FONT_BASE keeps the originals for Classic and for derived ramps. */
const FONT_SLOTS = 7;
let FONT_BASE = null;

// Genesis palette entries are 3 bits per channel, so legal values are multiples
// of 36. Snapping keeps derived ramps in the same colour space as the artwork.
const gsnap = v => Math.max(0, Math.min(252, Math.round(v/36)*36));
const shade = (c, f) => c.map(v => gsnap(v*f));
const tint  = (c, f) => c.map(v => gsnap(v + (252-v)*f));

/* Build a full ramp from one face colour, following the sheet's own roles. */
function rampFrom(face){
  return [shade(face,0.45), face.map(gsnap), shade(face,0.72), [252,252,252],
          tint(face,0.45), tint(face,0.72), shade(face,0.22)];
}

const PALETTES = {
  classic:  null,                                    // filled from FONT_BASE at load
  knuckles: [[144,0,0],[252,0,0],[180,0,0],[252,252,252],[252,108,108],[252,180,180],[72,0,36]],
  sonic:    [[0,0,144],[0,72,252],[0,0,216],[252,252,252],[108,180,252],[180,216,252],[0,0,72]],
  tails:    [[144,72,0],[252,144,0],[216,108,0],[252,252,252],[252,216,108],[252,252,180],[72,36,0]],
  shadow:   [[252,0,0],[108,108,108],[72,72,72],[252,252,252],[180,180,180],[216,216,216],[0,0,0]],
  emerald:  [[0,108,0],[0,216,72],[0,144,36],[252,252,252],[108,252,144],[180,252,216],[0,36,0]],
};

/* Recolouring rewrites PALETTE[1..7]; the tinted atlas and every indexed export
   path pick the change up from there. */
function applyPalette(cols){
  for(let i=0;i<FONT_SLOTS;i++) PALETTE[i+1] = cols[i].slice();
  tintKey = '';
}
const hexRgb = h => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
  return m ? [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)] : null; };

/* A palette selection is either a preset name or a hex face colour. */
/* Saved palettes live in localStorage. A saved entry keeps the sheet ramp and,
   if there were any, the per-line assignments -- so a two-tone title like the
   real logo comes back whole rather than as one colour you then reassign.
   Selectors for them are prefixed so a saved "sonic" cannot shadow the built-in. */
const SAVE_KEY = 'andknuckles.palettes.v1';
const SAVED_PREFIX = '*';
let SAVED = {};

function loadSaved(){
  try{
    const raw = localStorage.getItem(SAVE_KEY);
    const o = raw ? JSON.parse(raw) : {};
    SAVED = {};
    for(const [name, v] of Object.entries(o)){
      // tolerate anything that is not shaped like a palette rather than throwing
      if(!v || !Array.isArray(v.ramp) || v.ramp.length !== FONT_SLOTS) continue;
      const ramp = v.ramp.map(c => Array.isArray(c) && c.length === 3
        ? c.map(n => Math.max(0, Math.min(255, n|0))) : [0,0,0]);
      SAVED[name] = {ramp, lines: Array.isArray(v.lines) ? v.lines : []};
    }
  }catch(e){ SAVED = {}; }          // private mode, quota, corrupt JSON
}
function persistSaved(){
  try{ localStorage.setItem(SAVE_KEY, JSON.stringify(SAVED)); return true; }
  catch(e){ return false; }
}
/* Storage is unavailable on some origins -- a data: URL disables it outright,
   and private windows can too. Better to say so up front than to let someone
   name a preset and only then find out it cannot be kept. */
const STORAGE_OK = (() => {
  try{ localStorage.setItem(SAVE_KEY + '.probe', '1');
       localStorage.removeItem(SAVE_KEY + '.probe'); return true; }
  catch(e){ return false; }
})();

function rampOf(sel){
  if(!sel) return PALETTE.slice(1, FONT_SLOTS+1);      // whatever the sheet palette is now
  if(sel[0] === SAVED_PREFIX){
    const hit = SAVED[sel.slice(1)];
    return hit ? hit.ramp : PALETTE.slice(1, FONT_SLOTS+1);
  }
  if(PALETTES[sel]) return PALETTES[sel];
  const rgb = hexRgb(sel);
  return rgb ? rampFrom(rgb) : PALETTE.slice(1, FONT_SLOTS+1);
}
/* Lines default to the sheet palette; state.linePalettes overrides per line,
   which is how the original logo gets a blue SONIC over a red KNUCKLES. */
const rampForLine = i => rampOf(state.linePalettes[i]);
const rampKey = r => r.map(c=>c.join(',')).join('|');

/* One tinted atlas per distinct ramp on screen, cached by that ramp. */
const tintCache = new Map();
function tintedAtlas(ramp){
  ramp = ramp || PALETTE.slice(1, FONT_SLOTS+1);
  const key = rampKey(ramp);
  const hit = tintCache.get(key);
  if(hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = ATLAS_W; cv.height = ATLAS_H;
  const cx = cv.getContext('2d');
  const img = cx.createImageData(ATLAS_W, ATLAS_H);
  const d = img.data;
  for(let p=0, o=0; p<ATLAS_IDX.length; p++, o+=4){
    const v = ATLAS_IDX[p];
    if(!v) continue;                       // index 0 stays transparent
    const c = ramp[v-1];
    d[o]=c[0]; d[o+1]=c[1]; d[o+2]=c[2]; d[o+3]=255;
  }
  cx.putImageData(img, 0, 0);
  if(tintCache.size > 24) tintCache.clear();
  tintCache.set(key, cv);
  return cv;
}

/* Indexed exports need a palette slot per distinct ramp. The default ramp keeps
   slots 1..7; any extra ramp is appended past the scene colours and its glyph
   pixels are offset by that bank's base. */
function paletteBanks(L){
  const pal = PALETTE.slice();
  const defKey = rampKey(PALETTE.slice(1, FONT_SLOTS+1));
  const seen = new Map([[defKey, 0]]);
  const banks = L.lines.map((_, i) => {
    const key = rampKey(rampForLine(i));
    if(seen.has(key)) return seen.get(key);
    const base = pal.length - 1;           // base + v lands on the first new slot
    for(const c of rampForLine(i)) pal.push(c.slice());
    seen.set(key, base);
    return base;
  });
  return {pal, banks};
}
function buildIndexed(){
  const c = document.createElement('canvas');
  ATLAS_W = c.width = atlas.naturalWidth;
  ATLAS_H = c.height = atlas.naturalHeight;
  const x = c.getContext('2d', {willReadFrequently:true});
  x.drawImage(atlas, 0, 0);
  const d = x.getImageData(0, 0, ATLAS_W, ATLAS_H).data;
  const seen = new Map();
  PALETTE = [[0,0,0]];                       // index 0 reserved: transparent
  ATLAS_IDX = new Uint8Array(ATLAS_W * ATLAS_H);
  for(let i = 0, p = 0; i < d.length; i += 4, p++){
    if(d[i+3] < 128) continue;               // stays 0
    const k = (d[i]<<16) | (d[i+1]<<8) | d[i+2];
    let idx = seen.get(k);
    if(idx === undefined){
      idx = PALETTE.length;
      PALETTE.push([d[i], d[i+1], d[i+2]]);
      seen.set(k, idx);
    }
    ATLAS_IDX[p] = idx;
  }
}

/* Bounding box of the text block, in output pixels, for a given frame offset.
   Frames use GIF disposal 2 (restore to background), so each frame only has to
   carry the rectangle the block actually occupies -- the rest is cleared for
   us. Vertical travel makes that a large saving. */
function frameRect(L, scale, dy, G, W, H){
  const o = origin(L, G);
  let lo = Infinity, hi = -Infinity;
  L.lines.forEach(line => {
    if(!line.items.length) return;
    let ox = 0;
    if(state.align === 'center') ox = Math.round((L.w - line.w)/2);
    if(state.align === 'right')  ox = L.w - line.w;
    lo = Math.min(lo, ox); hi = Math.max(hi, ox + line.w);
  });
  if(lo === Infinity) return {x:0, y:0, w:1, h:1};
  const x0 = Math.max(0, Math.min(W, (o.x + lo)*scale));
  const x1 = Math.max(0, Math.min(W, (o.x + hi)*scale));
  const y0 = Math.max(0, Math.min(H, (o.y + dy)*scale));
  const y1 = Math.max(0, Math.min(H, (o.y + dy + L.h)*scale));
  if(x1 <= x0 || y1 <= y0) return {x:0, y:0, w:1, h:1};   // fully off-canvas
  return {x:x0, y:y0, w:x1-x0, h:y1-y0};
}

/* The background shares one palette with the font so a single indexed frame can
   hold both. Font colours keep indices 1-7; background colours append after. */
const bgImgs = {}, bgIdxs = {};
const sceneOn  = () => state.scene !== 'off';
const sceneImg = () => bgImgs[state.scene] || null;
const sceneIdx = () => bgIdxs[state.scene] || null;


/* The S&K intro is composed from layers rather than one flat image, because the
   Death Egg descends *behind* the mountain: back plane, egg, then mountain and
   characters, then the falling Sonic on top. Each layer is indexed into the
   shared palette the same way a scene is. */
const introLayers = {};
function buildIntro(id){
  const spec = SCENES[id].intro; if(!spec) return;
  const L = introLayers[id] = {front: []};
  const index = (img, opaqueLayer) => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d', {willReadFrequently:true});
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const seen = new Map();
    PALETTE.forEach((c2,i)=>{ if(i > FONT_SLOTS) seen.set((c2[0]<<16)|(c2[1]<<8)|c2[2], i); });
    const idx = new Uint8Array(c.width * c.height);
    for(let i=0, p=0; i<d.length; i+=4, p++){
      if(d[i+3] < 128) continue;                 // 0 = transparent for overlays
      const k = (d[i]<<16)|(d[i+1]<<8)|d[i+2];
      let v = seen.get(k);
      if(v === undefined){ v = PALETTE.length; PALETTE.push([d[i],d[i+1],d[i+2]]); seen.set(k, v); }
      idx[p] = v;
    }
    return {img, idx, w: c.width, h: c.height};
  };
  L.back = index(spec.back.img);
  for(const f of spec.front) L.front.push(index(f.img));
  L.egg   = Object.assign(index(spec.egg.img),   {x:spec.egg.x,   y:spec.egg.y,   anchorY:spec.egg.anchorY});
  L.sonic = Object.assign(index(spec.sonic.img), {x:spec.sonic.x, y:spec.sonic.y, anchorY:spec.sonic.anchorY});
  L.mtn   = Object.assign(index(spec.mtn.img),   {x:spec.mtn.x,   y:spec.mtn.y});
  L.hands = (spec.hands || []).map(h => h.patches.map(q =>
    q ? Object.assign(index(q.img), {x:q.x, y:q.y}) : null));
}

const sceneIntro = () => (SCENES[state.scene] || {}).intro || null;
const introOn = () => !!(state.intro && state.mode === 'anim' && sceneIntro() && introLayers[state.scene]);
/* SKTitle_ShakeOffsets -- read as an overlapping (y,x) pair at frame & $3F, and
   added to both planes' V_scroll while Screen_shake_flag runs. Sprites are not
   scroll-driven, so the Death Egg sits still while the ground jolts under it. */
const SHAKE = [1,2,1,3,1,2,2,1,2,3,1,2,1,2,0,0, 2,0,3,2,2,3,2,2,1,3,0,0,1,0,1,3,
               1,2,1,3,1,2,2,1,2,3,1,2,1,2,0,0, 2,0,3,2,2,3,2,2,1,3,0,0,1,0,1,3, 1,2];

/* The intro runs in two phases, both driven by Camera_Y_pos_P2.

   Phase 1  Obj_SKTitle_DeathEggMain: the egg falls $B0 -> $F0 at $8000/frame
            while the camera climbs 0 -> $80 at one pixel. The background plane
            is positioned from that camera, so it rises into frame as the egg
            comes down, and they meet at the volcano.

   Phase 2  Obj_SKTitle_DeathEggShake: the camera finishes $80 -> $100 and the
            egg is walked up by the same amount ("move Death Egg backwards to
            keep up with scroll"), landing on $F0-128 = $70 -- exactly the
            "proper position" the fast-forward path writes. So the egg is stuck
            to the terrain from the moment it touches down, and the whole scene
            rides up together into the title framing.

   Getting this wrong is what kept the mountain adrift: it sits at $1A8 minus
   the same camera, so any model where the background and the sprite disagree
   about the camera leaves it floating. */
function sonicFall(){ const s = sceneIntro(); return Math.ceil((s.sonicY1 - s.sonicY0) / s.fallPx); }
function introLen(){
  const s = sceneIntro(); if(!s) return 0;
  return sonicFall() + s.hold2 + s.hold3;
}
/* Obj_SKTitle_HandAnim is set up once the title is assembled, so the idle
   channels run from the moment the pose settles -- through the text spring and
   on past it. The tail is however much longer they need than the spring does;
   without it the smile, which waits 3*60 frames before it fires, never shows. */
function introTail(){
  const s = sceneIntro();
  if(!introOn() || !s || !s.hands) return 0;
  return Math.max(0, (s.idle || 0) - motion().frames.length);
}
/* Which state each hand channel is showing on timeline frame t, or null before
   the pose has settled. SKTitle_AnimateHands counts a per-channel timer down and
   steps the table when it underflows; $FF restarts, $FE rewinds one and so holds
   the last frame, which is why the smile is a one-shot. */
function handStates(t){
  const s = sceneIntro();
  if(!introOn() || !s || !s.hands) return null;
  const k = t - introLen();
  if(k < 0) return null;
  return s.hands.map(h => {
    // Two timing tweaks, both because this loop is far shorter than the title
    // screen the ROM wrote these for.
    //
    // `delay` -- the smile's wait before it fires. Obj_SKTitle_HandAnim sets
    // $30(a0) to 3*60, three seconds, which would land it on the last few frames.
    //
    // `phase` -- how far into its own table a channel starts. The finger idles
    // for 32 of its 45 steps before wagging, so at ROM phase only 4 of the wag's
    // 39 frames land inside the loop and it reads as not animating at all.
    // Starting it part-way through that idle run puts the wag in the middle,
    // and it is still the ROM's table played at the ROM's rate.
    const d = h.delay || 0;
    if(k < d) return h.idle;
    const step = Math.floor((k - d) / h.dur) + (h.hold ? 0 : (h.phase || 0));
    return h.hold ? h.seq[Math.min(step, h.seq.length - 1)]
                  : h.seq[((step % h.seq.length) + h.seq.length) % h.seq.length];
  });
}
/* Which layers, and where, on intro frame t. */
function introState(t){
  const s = sceneIntro();
  const sLand = sonicFall();
  let cam, eggY;
  if(t <= s.p1){
    const k = s.p1 ? t / s.p1 : 1;
    cam  = s.cam0  + (s.cam1  - s.cam0 ) * k;
    eggY = s.eggY0 + (s.eggY1 - s.eggY0) * k;
  } else {
    const k = Math.min(1, (t - s.p1) / s.p2);
    cam  = s.cam1  + (s.cam2  - s.cam1 ) * k;
    eggY = s.eggY1 + (s.eggY2 - s.eggY1) * k;
  }
  const bgOff = Math.round(s.cam2 - cam);          // how far the plane still has to rise
  const mtnOff = Math.round(s.mtn.anchorCam - cam);// $1A8 - cam, same amount
  const sonicY = Math.min(s.sonicY1, s.sonicY0 + t*s.fallPx);
  // Screen shake for the first stretch of phase 2. It is applied to the scroll
  // values and to both sprites -- but not to falling Sonic, who does not
  // subtract it in Obj_SKTitle_SonicFallMain.
  const jolt = t >= s.p1 && t < s.p1 + s.shake;
  const shakeY = jolt ? SHAKE[t & 63] : 0;
  // Plane A's frames only arrive once the camera has settled, rising from the
  // bottom as Copy_Map_Line_To_VRAM fills each newly exposed line.
  const reveal = Math.max(0, Math.min(1, (t - s.p1 - s.p2) / s.reveal));
  let f = 0;
  if(t >= sLand + s.hold2 + s.hold3) f = 3;
  else if(t >= sLand + s.hold2) f = 2;
  else if(t >= sLand) f = 1;
  return {f, eggY: Math.round(eggY), sonicY: Math.round(sonicY),
          falling: t < sLand, reveal, bgOff, mtnOff, shakeY};
}

function buildBackground(id){
  const c = document.createElement('canvas');
  c.width = BG_W; c.height = BG_H;
  const x = c.getContext('2d', {willReadFrequently:true});
  x.drawImage(bgImgs[id], 0, 0);
  const d = x.getImageData(0, 0, BG_W, BG_H).data;
  // Only dedupe against other scene colours. Indices 1..FONT_SLOTS belong to
  // the font and get rewritten by palette recolouring -- a scene sharing one
  // would be repainted along with the text, and they genuinely do share several
  // (S&K uses the font's red across 6958 pixels of Knuckles).
  const seen = new Map();
  PALETTE.forEach((c,i)=>{ if(i > FONT_SLOTS) seen.set((c[0]<<16)|(c[1]<<8)|c[2], i); });
  const IDX = bgIdxs[id] = new Uint8Array(BG_W * BG_H);
  for(let i = 0, p = 0; i < d.length; i += 4, p++){
    if(d[i+3] < 128) continue;
    const k = (d[i]<<16) | (d[i+1]<<8) | d[i+2];
    let idx = seen.get(k);
    if(idx === undefined){ idx = PALETTE.length; PALETTE.push([d[i],d[i+1],d[i+2]]); seen.set(k, idx); }
    IDX[p] = idx;
  }
}

/* How far the background has scrolled up on a given frame. */
function scrollAt(frame){
  if(!sceneOn()) return 0;
  if(state.mode !== 'anim') return BG_SCROLL;
  const t = frame - (introOn() ? introLen() : 0);
  return Math.max(0, Math.min(t, BG_SCROLL));
}

/* Fill an index buffer rect with the scrolled background. The strip exposed at
   the bottom by the scroll repeats the last row (it is open water there). */
/* Composite one intro layer into an index buffer. 0 in a layer means "leave
   whatever is underneath". */
function blitLayer(buf, rect, scale, lay, ox, oy, scroll, clampEdges){
  for(let ty = 0; ty < rect.h; ty++){
    let ly = Math.floor((ty + rect.y)/scale) + scroll - oy;
    // Full-plane layers repeat their edge rows into whatever the camera or the
    // V_scroll exposes -- sky above, land below. Sprites must not, or they smear.
    if(clampEdges){ if(ly < 0) ly = 0; else if(ly >= lay.h) ly = lay.h - 1; }
    if(ly < 0 || ly >= lay.h) continue;
    const srow = ly*lay.w, trow = ty*rect.w;
    for(let tx = 0; tx < rect.w; tx++){
      const lx = Math.floor((tx + rect.x)/scale) - ox;
      if(lx < 0 || lx >= lay.w) continue;
      const v = lay.idx[srow + lx];
      if(v) buf[trow + tx] = v;
    }
  }
}
function fillIntro(buf, rect, scale, scroll, frame){
  const L = introLayers[state.scene], st = introState(frame||0);
  const bo = st.bgOff - st.shakeY, mo = st.mtnOff - st.shakeY;
  blitLayer(buf, rect, scale, L.back, 0, bo, scroll, true);
  blitLayer(buf, rect, scale, L.egg, L.egg.x,
            L.egg.y + (st.eggY - L.egg.anchorY) - st.shakeY, scroll);
  blitLayer(buf, rect, scale, L.mtn, L.mtn.x, L.mtn.y + mo, scroll);
  const slide = st.f ? 0 : Math.round((1 - st.reveal) * BG_H);
  if(st.reveal > 0)
    blitLayer(buf, rect, scale, L.front[st.f], 0, slide + bo, scroll, slide === 0);
  const hs = handStates(frame||0);
  if(hs) hs.forEach((v, i) => {
    const q = L.hands[i][v];
    if(q) blitLayer(buf, rect, scale, q, q.x, q.y, scroll);
  });
  if(st.falling)
    blitLayer(buf, rect, scale, L.sonic, L.sonic.x, L.sonic.y + (st.sonicY - L.sonic.anchorY), scroll);
}

function fillBackground(buf, rect, scale, scroll){
  const IDX = sceneIdx();
  if(!IDX) return;
  for(let ty = 0; ty < rect.h; ty++){
    const sy0 = Math.floor((ty + rect.y) / scale) + scroll;
    const sy = Math.min(BG_H - 1, sy0);
    const srow = sy * BG_W, trow = ty * rect.w;
    for(let tx = 0; tx < rect.w; tx++){
      const sx = Math.floor((tx + rect.x) / scale);
      buf[trow + tx] = sx < BG_W ? IDX[srow + sx] : 0;
    }
  }
}

/* Draw one frame into a palette-index buffer (0 = transparent). */
function paintIndexed(rect, scale, L, dy, G, bgIdx, scroll, banks, frame){
  const W = rect.w, H = rect.h;
  const buf = new Uint8Array(W * H);
  if(G.scene && introOn()) fillIntro(buf, rect, scale, scroll||0, frame);
  else if(G.scene) fillBackground(buf, rect, scale, scroll||0);
  else if(bgIdx) buf.fill(bgIdx);
  const o = origin(L, G);
  L.lines.forEach((line, i) => {
    let ox = 0;
    if(state.align === 'center') ox = Math.round((L.w - line.w)/2);
    if(state.align === 'right')  ox = L.w - line.w;
    const oy = i*(L.rowh + state.lead);
    for(const {g, x} of line.items){
      const dx0 = (o.x + ox + x)*scale - rect.x;
      const dy0 = (o.y + oy + g[4] + dy)*scale - rect.y;
      const bank = banks ? banks[i] : 0;
      const [sx, sy, sw, sh] = g;
      for(let yy = 0; yy < sh; yy++){
        const srow = (sy + yy)*ATLAS_W + sx;
        for(let ry = 0; ry < scale; ry++){
          const ty = dy0 + yy*scale + ry;
          if(ty < 0 || ty >= H) continue;
          const trow = ty*W;
          for(let xx = 0; xx < sw; xx++){
            const v = ATLAS_IDX[srow + xx];
            if(!v) continue;
            const bv = bank + v;
            const tx0 = dx0 + xx*scale;
            for(let rx = 0; rx < scale; rx++){
              const tx = tx0 + rx;
              if(tx >= 0 && tx < W) buf[trow + tx] = bv;
            }
          }
        }
      }
    }
  });
  return buf;
}

/* ---------- GIF89a encoder ------------------------------------------------
   Hard-edged art with a tiny palette, so 1-bit GIF transparency is lossless
   here and the whole thing fits a 3-bit colour table.                      */
function lzwEncode(px, minCodeSize){
  const clear = 1 << minCodeSize, eoi = clear + 1;
  const out = [];
  let dict = new Map(), next = eoi + 1, codeSize = minCodeSize + 1;
  let cur = 0, curBits = 0;
  const emit = code => {
    cur |= code << curBits;
    curBits += codeSize;
    while(curBits >= 8){ out.push(cur & 0xFF); cur >>>= 8; curBits -= 8; }
  };
  const reset = () => { dict = new Map(); next = eoi + 1; codeSize = minCodeSize + 1; };
  emit(clear);
  let prefix = px[0];
  for(let i = 1; i < px.length; i++){
    const k = px[i], key = (prefix << 8) | k;
    const hit = dict.get(key);
    if(hit !== undefined){ prefix = hit; continue; }
    emit(prefix);
    dict.set(key, next++);
    // The decoder builds its table one entry behind the encoder, so it must
    // widen one code later than a naive reading of the spec suggests. Growing
    // at (1<<codeSize) desyncs every real decoder at the first width change;
    // (1<<codeSize)+1 is what they actually expect. Emitted codes are always
    // < next, so they still fit the current width.
    if(next === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
    else if(next > 4095){ emit(clear); reset(); }   // table full
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if(curBits > 0) out.push(cur & 0xFF);
  return out;
}

function buildGif(frames, W, H, palette){
  const b = [];
  const str = t => { for(const ch of t) b.push(ch.charCodeAt(0)); };
  const u16 = v => b.push(v & 0xFF, (v >> 8) & 0xFF);
  const bits = Math.max(2, Math.ceil(Math.log2(Math.max(2, palette.length))));
  const entries = 1 << bits;

  str('GIF89a');
  u16(W); u16(H);
  b.push(0x80 | 0x70 | (bits - 1), 0, 0);        // GCT present, size = 2^bits
  for(let i = 0; i < entries; i++){
    const c = palette[i] || [0,0,0];
    b.push(c[0], c[1], c[2]);
  }
  b.push(0x21, 0xFF, 11); str('NETSCAPE2.0'); b.push(3, 1, 0, 0, 0);  // loop forever

  for(const f of frames){
    const d = Math.max(1, Math.round(f.delay || 2));
    const packed = (((f.gifDispose === undefined ? 2 : f.gifDispose) & 7) << 2) | 1;
    b.push(0x21, 0xF9, 4, packed, d & 0xFF, (d >> 8) & 0xFF, 0, 0);
    b.push(0x2C); u16(f.x); u16(f.y); u16(f.w); u16(f.h); b.push(0);
    b.push(bits);
    const data = lzwEncode(f.buf, bits);
    for(let i = 0; i < data.length; i += 255){
      const chunk = data.slice(i, i + 255);
      b.push(chunk.length);
      for(const v of chunk) b.push(v);
    }
    b.push(0);
  }
  b.push(0x3B);
  return new Uint8Array(b);
}

/* ---------- APNG encoder ---------------------------------------------------
   Worth having alongside GIF for one specific reason: APNG frame delays are a
   rational number (delay_num / delay_den), not whole centiseconds. So it can
   express 1/59.92s exactly -- true NTSC frame timing, which GIF cannot
   represent at all. Deflate comes from CompressionStream, so still no
   dependency.                                                              */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for(let n = 0; n < 256; n++){
    let c = n;
    for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes){
  let c = 0xFFFFFFFF;
  for(let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data){
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for(let i = 0; i < 4; i++) out[4+i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function deflate(bytes){
  const cs = new CompressionStream('deflate');            // zlib wrapper, as PNG wants
  const w = cs.writable.getWriter();
  w.write(bytes); w.close();
  const parts = [], rd = cs.readable.getReader();
  for(;;){ const {done, value} = await rd.read(); if(done) break; parts.push(value); }
  const total = parts.reduce((a,p)=>a+p.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for(const p of parts){ out.set(p, o); o += p.length; }
  return out;
}

/* Pack an index buffer into filtered PNG scanlines. Adaptive None/Up per row:
   at integer pixel scale every source row repeats, so Up zeroes most rows. */
function pngScanlines(buf, w, h, depth){
  const stride = depth === 4 ? ((w + 1) >> 1) : w;
  const raw = new Uint8Array((stride + 1) * h);
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  for(let y = 0; y < h; y++){
    cur.fill(0);
    if(depth === 4){
      for(let x = 0; x < w; x++){
        const v = buf[y*w + x] & 0x0F;
        if(x & 1) cur[x >> 1] |= v; else cur[x >> 1] = v << 4;
      }
    } else {
      cur.set(buf.subarray(y*w, y*w + w));
    }
    let sumNone = 0, sumUp = 0;
    for(let i = 0; i < stride; i++){
      const n = cur[i], u = (cur[i] - prev[i]) & 0xFF;
      sumNone += n < 128 ? n : 256 - n;
      sumUp   += u < 128 ? u : 256 - u;
    }
    const useUp = sumUp < sumNone;
    const base = y * (stride + 1);
    raw[base] = useUp ? 2 : 0;
    for(let i = 0; i < stride; i++)
      raw[base + 1 + i] = useUp ? (cur[i] - prev[i]) & 0xFF : cur[i];
    prev.set(cur);
  }
  return raw;
}

async function buildApng(frames, W, H, palette, delayDen){
  const depth = palette.length <= 16 ? 4 : 8;
  const be = (...v) => { const a = new Uint8Array(v.length*4); const d = new DataView(a.buffer);
                         v.forEach((x,i)=>d.setUint32(i*4, x)); return a; };
  const parts = [new Uint8Array([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A])];

  const ihdr = new Uint8Array(13); const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, W); iv.setUint32(4, H);
  ihdr[8] = depth; ihdr[9] = 3;                            // colour type 3 = indexed
  parts.push(pngChunk('IHDR', ihdr));
  parts.push(pngChunk('acTL', be(frames.length, 0)));      // 0 plays = loop forever

  const plte = new Uint8Array(palette.length * 3);
  palette.forEach((c,i)=>{ plte[i*3]=c[0]; plte[i*3+1]=c[1]; plte[i*3+2]=c[2]; });
  parts.push(pngChunk('PLTE', plte));
  parts.push(pngChunk('tRNS', new Uint8Array([0])));       // index 0 fully transparent

  let seq = 0;
  for(let i = 0; i < frames.length; i++){
    const f = frames[i];
    const fctl = new Uint8Array(26); const fv = new DataView(fctl.buffer);
    fv.setUint32(0, seq++); fv.setUint32(4, f.w); fv.setUint32(8, f.h);
    fv.setUint32(12, f.x);  fv.setUint32(16, f.y);
    fv.setUint16(20, f.delayNum); fv.setUint16(22, delayDen);
    fctl[24] = f.dispose === undefined ? 1 : f.dispose;    // 0 = leave, 1 = clear
    fctl[25] = 0;                                          // blend: source
    parts.push(pngChunk('fcTL', fctl));
    const data = await deflate(pngScanlines(f.buf, f.w, f.h, depth));
    if(i === 0){
      parts.push(pngChunk('IDAT', data));
    } else {
      const fd = new Uint8Array(4 + data.length);
      new DataView(fd.buffer).setUint32(0, seq++);
      fd.set(data, 4);
      parts.push(pngChunk('fdAT', fd));
    }
  }
  parts.push(pngChunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((a,p)=>a+p.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for(const p of parts){ out.set(p, o); o += p.length; }
  return out;
}

/* ---------- export ---------- */
/* Still exports always render the settled pose with no headroom, so PNG /
   WebP / AVIF output is unchanged by animation settings. */
function exportCanvas(){
  const off = document.createElement('canvas');
  const L = layout();
  // force zero headroom so still output is unaffected by animation settings
  const G = sceneOn() ? geom(L)
                        : {head:0, w0:L.w + state.pad*2, h0:L.h + state.pad*2};
  const scale = clampScale(G.w0, G.h0, state.scale, STILL_BUDGET);
  paint(off, scale, L, 0, G, scrollAt(1e9));
  return off;
}

/* ---------- animated export ---------- */
function gifPalette(L){
  const pal = L ? paletteBanks(L).pal : PALETTE.slice();
  let bgIdx = 0;
  if(state.bg !== 'none'){
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(state.bg);
    if(m){ bgIdx = pal.length; pal.push([parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)]); }
  }
  return {pal, bgIdx};
}

/* Only the Death Egg and the falling Sonic move during the intro, so a frame
   needs the union of where they were and where they are -- not a full repaint. */
function introRect(t, scale, W, H){
  const L = introLayers[state.scene]; if(!L) return {x:0,y:0,w:W,h:H};
  const st = introState(t), pv = introState(Math.max(0, t-1));
  // Every layer is drawn shifted up by the V_scroll, so the rects have to be too.
  // The egg and Sonic only move while it is still 0, which hid this until the
  // hand patches started stepping during the text phase, where it is 16.
  const sc = scrollAt(t) * scale;
  const box = (lay, oy) => ({x: lay.x*scale, y: (lay.y + oy)*scale - sc,
                             w: lay.w*scale, h: lay.h*scale});
  // Only what actually moved. The egg is still for the whole text phase, and
  // including it there cost a full egg-sized rect on every one of those frames.
  // The caller unions the previous rect in, so the erase is still covered.
  let r = null;
  const add = q => { r = r ? rectUnion(r, q) : q; };
  // The camera pan, the shake and the sliding plane all move full-frame content,
  // so there is no sub-rect to send while any of them is running.
  if(st.bgOff !== pv.bgOff || st.mtnOff !== pv.mtnOff || st.shakeY !== pv.shakeY)
    return {x:0, y:0, w:W, h:H};
  if(st.reveal !== pv.reveal && st.f === 0) return {x:0, y:0, w:W, h:H};
  if(t === 0 || st.eggY !== pv.eggY) add(box(L.egg, st.eggY - L.egg.anchorY));
  if(st.falling) add(box(L.sonic, st.sonicY - L.sonic.anchorY));
  // A hand channel that stepped this frame: both the state it left and the one
  // it arrived at, so the old pixels get painted over.
  const hs = handStates(t), hp = handStates(Math.max(0, t-1));
  if(hs && hp) hs.forEach((v, i) => {
    if(v === hp[i]) return;
    for(const w of [v, hp[i]]){
      const q = L.hands[i][w];
      if(q) add({x: q.x*scale, y: q.y*scale - sc, w: q.w*scale, h: q.h*scale});
    }
  });
  if(!r) return null;                      // nothing moved -- not a 1x1 at the
                                           // origin, which would drag the union
                                           // all the way up from the text band
  const x0 = Math.max(0, Math.min(W, r.x)), y0 = Math.max(0, Math.min(H, r.y));
  const x1 = Math.max(0, Math.min(W, r.x + r.w)), y1 = Math.max(0, Math.min(H, r.y + r.h));
  return (x1<=x0 || y1<=y0) ? {x:0,y:0,w:1,h:1} : {x:x0, y:y0, w:x1-x0, h:y1-y0};
}

function rectUnion(a, b){
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x+a.w, b.x+b.w) - x, h: Math.max(a.y+a.h, b.y+b.h) - y };
}

/* Frames for both containers. Without a scene the text is drawn on transparency
   and each frame is disposed back to it, so a frame only needs its own text
   rect. With a scene the background must persist, so frames are left in place
   and each one repaints the union of the previous and current text rects --
   which is what erases the old position. Any frame where the background scroll
   moved has to be a full repaint. */
/* The dirty rectangle each run gets. Stateful -- a frame is a delta against the
   one before it -- so it has to walk the whole list in order. animFrames and the
   size estimate both go through here; when the estimate had its own simpler copy
   of this it never saw the intro's full repaints and read about 3x low. */
function frameRects(F, kind){
  const {W, H, bgIdx, runs, L, g, scale} = F;
  const scene = !!g.scene;
  const out = [];
  let prevText = null, prevScroll = -1, prevIntro = null, prevF = null, prevDy = null;
  for(let i = 0; i < runs.length; i++){
    const r = runs[i];
    let rect;
    if(scene){
      const cur = frameRect(L, scale, r.dy, g, W, H);
      if(i === 0 || r.scroll !== prevScroll){
        rect = {x:0, y:0, w:W, h:H};
      } else {
        rect = null;
        const add = q => { rect = rect ? rectUnion(rect, q) : q; };
        // Only send the text band when the text actually moved. It is parked at
        // rest for the whole idle tail, and unioning it with a hand patch high
        // up the frame produced a tall rect for every step of the animation.
        if(r.dy !== prevDy) add(rectUnion(prevText, cur));
        if(introOn()){
          const ir = introRect(r.frame, scale, W, H);
          // union in the old position too, so whatever moved gets erased
          const moved = (ir && prevIntro) ? rectUnion(prevIntro, ir) : (ir || prevIntro);
          if(moved) add(moved);
          if(prevF !== null && introState(r.frame).f !== prevF) rect = {x:0,y:0,w:W,h:H};
          prevIntro = ir; prevF = introState(r.frame).f;
        }
        if(!rect) rect = rectUnion(prevText, cur);
      }
      prevText = cur; prevScroll = r.scroll; prevDy = r.dy;
    } else if(bgIdx || (kind === 'apng' && i === 0)){
      rect = {x:0, y:0, w:W, h:H};          // opaque bg, or APNG's mandatory full first frame
    } else {
      rect = frameRect(L, scale, r.dy, g, W, H);
    }
    out.push(rect);
  }
  return out;
}

function animFrames(kind){
  const F = gifFrames(kind === 'gif');
  const {W, H, pal, bgIdx, runs, offs, L, g, scale} = F;
  const scene = !!g.scene;
  const per = state.timebase === 'ntsc' ? 100 : 1;
  const rects = frameRects(F, kind);
  const frames = [];
  for(let i = 0; i < runs.length; i++){
    const r = runs[i], rect = rects[i];
    frames.push(Object.assign({
      buf: paintIndexed(rect, scale, L, r.dy, g, bgIdx, r.scroll, F.banks, r.frame),
      delay: r.delay * 2,                    // GIF: centiseconds
      delayNum: r.delay * per,               // APNG: numerator over den
      dispose: scene ? 0 : 1,                // APNG: 0 = leave, 1 = clear
      gifDispose: scene ? 1 : 2,             // GIF:  1 = leave, 2 = restore to bg
    }, rect));
  }
  return {frames, W, H, pal, scale, runs, offs, scene,
          den: state.timebase === 'ntsc' ? 5992 : 50};
}

/* allowResample is a GIF-only concession: GIF can't express 59.92Hz, so NTSC is
   approximated by dropping to 83 frames. APNG expresses it exactly and must NOT
   resample, or the two corrections compound. */
function gifFrames(allowResample){
  if(allowResample === undefined) allowResample = true;
  const L = layout(), g = geom(L), scale = scaleFor(L);
  const W = g.w0*scale, H = g.h0*scale;
  const {pal, bgIdx} = gifPalette(L);
  const banks = paletteBanks(L).banks;
  let offs = motion().frames;
  if(allowResample && state.timebase === 'ntsc'){
    // resample the ROM curve onto a 50fps grid so wall-clock matches NTSC
    const n = Math.round(offs.length / 59.92 / (FRAME_MS/1000));
    const src = offs;
    offs = Array.from({length:n}, (_,i) => src[Math.min(src.length-1, Math.round(i*(src.length-1)/(n-1)))]);
  }
  // The spring holds still for several frames at a time near each turning point
  // and at rest. Collapsing each run into one frame with a proportionally longer
  // delay is exactly equivalent playback and drops roughly a third of the frames.
  // With the intro on, the text waits: it holds at its entry position (off the
  // bottom of the frame) until Sonic has landed, then springs in.
  const iLen = introOn() ? introLen() : 0;
  if(iLen){ offs = Array(iLen).fill(offs[0]).concat(offs.slice()); }
  const tail = introTail();
  if(tail) offs = offs.concat(Array(tail).fill(offs[offs.length-1]));
  const runs = [];
  offs.forEach((dy, i) => {
    const scroll = scrollAt(i);
    const st = introOn() ? introState(i) : null;
    const sig = st ? st.f + ':' + st.eggY + ':' + (st.falling ? st.sonicY : -1)
                     + ':' + Math.round(st.reveal * BG_H)
                     + ':' + st.bgOff + ':' + st.mtnOff + ':' + st.shakeY
                     + ':' + (handStates(i) || []).join(',') : '';
    const last = runs[runs.length-1];
    if(last && last.dy === dy && last.scroll === scroll && last.sig === sig) last.delay += 1;
    else runs.push({dy, scroll, sig, delay:1, frame:i});
  });
  return {W, H, pal, bgIdx, banks, offs, runs, L, g, scale};
}

function estimateGif(){
  const F = gifFrames();
  const {W,H,pal,bgIdx,banks,runs,L,g,scale} = F;
  const rects = frameRects(F, 'gif');
  const bits = Math.max(2, Math.ceil(Math.log2(Math.max(2, pal.length))));
  // Sample a few frames for a bytes-per-pixel rate, then scale by the total area
  // actually being encoded. Weighting by frame count instead badly misreads a
  // timeline that mixes whole-screen repaints with small text rects.
  const probe = [...new Set([0, runs.length>>2, runs.length>>1, runs.length-1])]
                  .filter(i => i >= 0 && i < runs.length);
  let bytes = 0, px = 0;
  for(const i of probe){
    const r = runs[i], rect = rects[i];
    bytes += lzwEncode(paintIndexed(rect, scale, L, r.dy, g, bgIdx, r.scroll, banks, r.frame), bits).length;
    px += rect.w * rect.h;
  }
  const perPx = px ? bytes / px : 0;
  const total = rects.reduce((a, q) => a + q.w * q.h, 0);
  return perPx * total + runs.length * 18 + pal.length * 3 + 800;
}

let estTimer = 0;
function queueEstimate(){
  clearTimeout(estTimer);
  el('sizeOut').textContent = '…';
  estTimer = setTimeout(()=>{
    if(state.mode !== 'anim' || !state.text.trim()){ el('sizeOut').textContent = ''; return; }
    try{
      const n = estimateGif();
      el('sizeOut').textContent = '≈' + (n > 1048576 ? (n/1048576).toFixed(1)+' MB' : Math.round(n/1024)+' KB');
    }catch(e){ el('sizeOut').textContent = ''; }
  }, 450);
}

/* ---------- animated export: APNG ---------- */
// NTSC is 59.92Hz. GIF cannot express that; APNG can, exactly, as 100/5992.
const apngFrames = () => animFrames('apng');

async function downloadApng(){
  const btn = el('dlApng'); btn.disabled = true;
  const wasPlaying = player.playing; pause();
  try{
    say('Rendering…');
    await new Promise(r => setTimeout(r, 0));
    const {frames, W, H, pal, den} = apngFrames();
    say('Encoding…');
    await new Promise(r => setTimeout(r, 0));
    const bytes = await buildApng(frames, W, H, pal, den);
    const blob = new Blob([bytes], {type:'image/apng'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName('png'); a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    say('Saved APNG · ' + frames.length + ' frames · '
        + (state.timebase === 'ntsc' ? '59.92' : '50') + ' Hz exact · '
        + Math.round(blob.size/1024) + ' KB');
  }catch(err){
    say('APNG failed — try a lower scale');
  }finally{
    btn.disabled = false;
    if(wasPlaying) play();
  }
}

/* ---------- animated export: WebM / MP4 -----------------------------------
   MediaRecorder timestamps frames by when they actually arrive, so this is a
   real-time capture: a 2s animation takes 2s to record and the frame timing is
   only as good as the main thread was on the day. captureStream(0) at least
   makes the frame *contents* deterministic -- each one is pushed explicitly
   rather than sampled off the compositor. Lossy, and H.264 has no alpha.   */
async function recordVideo(mime, ext, btnId){
  const btn = el(btnId); btn.disabled = true;
  const wasPlaying = player.playing; pause();
  let stop = () => {};
  try{
    const L = layout(), g = geom(L), scale = scaleFor(L);
    const W = g.w0*scale, H = g.h0*scale;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const frames = motion().frames;
    const stream = cv.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 12e6});
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const done = new Promise(r => rec.onstop = r);
    stop = () => { try{ rec.stop(); }catch(e){} };
    rec.start();
    const step = state.timebase === 'ntsc' ? 1000/59.92 : 20;
    const iLen = introOn() ? introLen() : 0, iTail = introTail();
    let t0 = performance.now();
    for(let i = 0; i < frames.length + iLen + iTail; i++){
      paint(cv, scale, L, frames[Math.max(0, Math.min(frames.length-1, i - iLen))], g, scrollAt(i), i);
      if(track.requestFrame) track.requestFrame();
      if(i % 10 === 0) say('Recording ' + Math.round(i/(frames.length+iLen+iTail)*100) + '%');
      const target = t0 + (i+1)*step;
      await new Promise(r => setTimeout(r, Math.max(0, target - performance.now())));
    }
    rec.stop(); await done;
    const blob = new Blob(chunks, {type: mime.split(';')[0]});
    if(!blob.size) throw new Error('empty recording');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName(ext); a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    say('Saved ' + ext.toUpperCase() + ' · real-time capture · ' + Math.round(blob.size/1024) + ' KB');
  }catch(err){
    stop();
    say(ext.toUpperCase() + ' failed — ' + (err.message || 'not supported here'));
  }finally{
    btn.disabled = false;
    if(wasPlaying) play();
  }
}

const VIDEO = {
  webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
  mp4:  ['video/mp4;codecs=avc1.42E01E', 'video/mp4'],
};
function videoMime(kind){
  if(typeof MediaRecorder === 'undefined') return null;
  return VIDEO[kind].find(t => MediaRecorder.isTypeSupported(t)) || null;
}
const SUP_APNG = typeof CompressionStream !== 'undefined';

async function downloadGif(){
  const btn = el('dlGif');
  btn.disabled = true;
  const wasPlaying = player.playing;
  pause();
  try{
    say('Rendering…');
    await new Promise(r => setTimeout(r, 0));
    const {frames, W, H, pal, runs, offs} = animFrames('gif');
    say('Encoding…');
    await new Promise(r => setTimeout(r, 0));
    const bytes = buildGif(frames, W, H, pal);
    const blob = new Blob([bytes], {type:'image/gif'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName('gif'); a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    say('Saved GIF · ' + runs.length + ' frames (' + offs.length + ' ROM) · '
        + (offs.length*FRAME_MS/1000).toFixed(2) + 's · ' + Math.round(blob.size/1024) + ' KB');
  }catch(err){
    say('GIF failed — try a lower scale');
  }finally{
    btn.disabled = false;
    if(wasPlaying) play();
  }
}
function fileName(ext){
  const base = state.text.trim().toUpperCase().replace(/&/g,'and')
    .replace(/[^A-Z0-9]+/gi,'-').replace(/^-|-$/g,'').toLowerCase().slice(0,48);
  return (base || 'title-screen-text') + '.' + ext;
}
function say(msg){ el('status').textContent = msg; clearTimeout(say.t); say.t = setTimeout(()=>el('status').textContent='',2600); }

function download(mime, ext){
  const off = exportCanvas();
  off.toBlob(blob=>{
    if(!blob || blob.type !== mime){ say(ext + ' not supported here'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName(ext); a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    say('Saved ' + ext.toUpperCase() + ' · ' + Math.round(blob.size/1024) + ' KB');
  }, mime, 1);
}

function supports(mime){
  const c = document.createElement('canvas'); c.width = c.height = 1;
  return c.toDataURL(mime).startsWith('data:' + mime);
}

/* ---------- wiring ---------- */
el('text').addEventListener('input', e=>{
  state.text = e.target.value;
  // typing while paused should show what you typed, not a mid-entry frame
  if(state.mode === 'anim' && !player.playing) showRest();
  render();
});

document.querySelectorAll('.chip').forEach(b=>b.addEventListener('click',()=>{
  state.text = b.dataset.preset; el('text').value = state.text; render(); el('text').focus();
}));

el('style').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.style = b.dataset.style;
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  const d = DEFAULTS[state.style];
  if(!state.touchedTrack){ state.track = d.track; el('track').value = d.track; el('trackVal').textContent = d.track; }
  if(!state.touchedLead){ state.lead = d.lead; el('lead').value = d.lead; el('leadVal').textContent = d.lead; }
  render();
});

/* One row of palette chips per line of text. Rebuilt whenever the line count
   changes, preserving whatever each line was already set to. */
function renderLineRows(){
  const n = layout().lines.length;
  const box = el('lineCtl');
  if(n < 2){ box.hidden = true; return; }
  box.hidden = false;
  el('lineHint').textContent = n + ' lines';
  const host = el('lines');
  if(+host.dataset.n === n) { syncLineChips(); return; }
  host.dataset.n = n;
  host.innerHTML = '';
  for(let i = 0; i < n; i++){
    const row = document.createElement('div');
    row.className = 'lineRow';
    row.innerHTML = '<span class="who">Line ' + (i+1) + '</span>';
    const add = (sel, title, style, cls) => {
      const b = document.createElement('button');
      b.className = 'chip2' + (cls ? ' ' + cls : '');
      b.title = title; b.dataset.line = i; b.dataset.sel = sel;
      if(style) b.style.background = style;
      row.appendChild(b);
    };
    add('', 'Follow the sheet palette', '', 'auto');
    for(const name of Object.keys(PALETTES)){
      const face = (PALETTES[name] || FONT_BASE)[1];
      add(name, name[0].toUpperCase()+name.slice(1), 'rgb('+face.join(',')+')');
    }
    for(const name of Object.keys(SAVED).sort()){
      const face = SAVED[name].ramp[1];
      add(SAVED_PREFIX+name, name, 'rgb('+face.join(',')+')');
    }
    const pick = document.createElement('input');
    pick.type = 'color'; pick.dataset.line = i;
    pick.title = 'Custom colour for this line';
    pick.value = '#FC0000';
    row.appendChild(pick);
    host.appendChild(row);
  }
  syncLineChips();
}
function syncLineChips(){
  el('lines').querySelectorAll('.chip2').forEach(b=>{
    const cur = state.linePalettes[+b.dataset.line] || '';
    b.setAttribute('aria-pressed', String(cur === b.dataset.sel));
  });
}
el('lines').addEventListener('click', e=>{
  const b = e.target.closest('.chip2'); if(!b) return;
  state.linePalettes[+b.dataset.line] = b.dataset.sel || undefined;
  syncLineChips();
  render();
});
el('lines').addEventListener('input', e=>{
  const t = e.target;
  if(t.type !== 'color') return;
  state.linePalettes[+t.dataset.line] = t.value;
  syncLineChips();
  render();
});

/* Saved palettes: chips that apply, plus a delete on each. */
function renderSaved(){
  const host = el('savedList');
  host.innerHTML = '';
  const names = Object.keys(SAVED).sort();
  if(!names.length){
    host.innerHTML = '<span class="lbl" style="margin:0;color:#6A5AA8">none yet</span>';
    return;
  }
  for(const name of names){
    const face = SAVED[name].ramp[1];
    const wrap = document.createElement('span');
    wrap.className = 'savedChip';
    const apply = document.createElement('button');
    apply.dataset.apply = name;
    apply.title = 'Apply ' + name;
    apply.innerHTML = '<i style="background:rgb(' + face.join(',') + ')"></i>' +
                      name.replace(/[<>&]/g, '');
    const del = document.createElement('button');
    del.className = 'del'; del.dataset.del = name;
    del.title = 'Delete ' + name; del.textContent = '\u00d7';
    wrap.append(apply, del);
    host.appendChild(wrap);
  }
}
function flash(msg){
  el('saveMsg').textContent = msg;
  clearTimeout(flash.t); flash.t = setTimeout(()=>el('saveMsg').textContent='', 2600);
}
el('savePal').addEventListener('click', ()=>{
  const name = el('saveName').value.trim();
  if(!name){ flash('name it first'); el('saveName').focus(); return; }
  SAVED[name] = {
    ramp: PALETTE.slice(1, FONT_SLOTS+1).map(c=>c.slice()),
    lines: state.linePalettes.slice(0, layout().lines.length),
  };
  if(!persistSaved()){ delete SAVED[name]; flash('could not save here'); return; }
  el('saveName').value = '';
  renderSaved(); renderLineRows();
  flash('saved ' + name);
});
el('savedList').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  if(b.dataset.del){
    delete SAVED[b.dataset.del];
    persistSaved();
    renderSaved(); renderLineRows();
    flash('deleted ' + b.dataset.del);
    return;
  }
  const name = b.dataset.apply; if(!name) return;
  const entry = SAVED[name];
  applyPalette(entry.ramp);
  state.linePalettes = entry.lines.slice();
  state.palette = SAVED_PREFIX + name;
  el('palette').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed','false'));
  renderLineRows(); syncLineChips();
  render();
  flash('loaded ' + name);
});

el('palette').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.palette = b.dataset.pal;
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  applyPalette(PALETTES[state.palette]);
  render();
});
el('tint').addEventListener('input', e=>{
  state.tint = e.target.value;
  state.palette = 'custom';
  el('palette').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed','false'));
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(e.target.value);
  if(m) applyPalette(rampFrom([parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)]));
  render();
});

el('align').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.align = b.dataset.align;
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  render();
});

const sliders = [['scale','scaleVal','×'],['track','trackVal',''],['lead','leadVal',''],['pad','padVal','']];
sliders.forEach(([id,out,suffix])=>{
  el(id).addEventListener('input', e=>{
    state[id] = +e.target.value;
    el(out).textContent = e.target.value + suffix;
    if(id==='track') state.touchedTrack = true;
    if(id==='lead') state.touchedLead = true;
    render();
  });
});

document.querySelectorAll('.swatch').forEach(b=>b.addEventListener('click',()=>{
  state.bg = b.dataset.bg;
  document.querySelectorAll('.swatch').forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  el('stage').classList.toggle('checker', state.bg === 'none');
  render();
}));
el('custom').addEventListener('input', e=>{
  state.bg = e.target.value;
  document.querySelectorAll('.swatch').forEach(x=>x.setAttribute('aria-pressed','false'));
  el('stage').classList.remove('checker');
  render();
});

/* ---------- animation wiring ---------- */
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

el('mode').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.mode = b.dataset.mode;
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  document.body.classList.toggle('anim', state.mode === 'anim');
  pause();
  showRest();
  render();
});

el('timebase').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.timebase = b.dataset.tb;
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  render();
});

el('scene').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b || b.disabled) return;
  state.scene = b.dataset.scene;
  if(state.scene !== 'off'){
    state.sceneY = SCENES[state.scene].y;
    el('sceneY').value = state.sceneY; el('sceneYVal').textContent = state.sceneY;
  }
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  document.body.classList.toggle('scene', sceneOn());
  document.body.classList.toggle('has-intro', !!sceneIntro());
  curveCache.key = '';
  if(!player.playing) showRest();
  render();
});
el('intro').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.intro = b.dataset.intro === 'on';
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  player.frame = 0;
  render();
});
el('sceneY').addEventListener('input', e=>{
  state.sceneY = +e.target.value;
  el('sceneYVal').textContent = e.target.value;
  render();
});

el('play').addEventListener('click', ()=> player.playing ? pause() : play());
el('scrub').addEventListener('input', e=>{ pause(); player.frame = +e.target.value; render(); });

const MOTION = [
  ['dist','distVal',  v => String(v)],
  ['vel0','vel0Val',  v => String(v)],
  ['accel','accelVal',v => String(v)],
  ['damp','dampVal',  v => String(v)],
  ['amp','ampVal',    v => v + '%'],
  ['head','headVal',  v => v < 0 ? 'auto' : String(v)]
];
MOTION.forEach(([id,out,fmt])=>{
  el(id).addEventListener('input', e=>{
    state[id] = +e.target.value;
    el(out).textContent = fmt(+e.target.value);
    if(player.frame >= motion().frames.length) showRest();
    render();
  });
});

el('romReset').addEventListener('click', ()=>{
  Object.assign(state, ROM, {amp:100, head:-1});
  MOTION.forEach(([id,out,fmt])=>{ el(id).value = state[id]; el(out).textContent = fmt(state[id]); });
  if(!player.playing) showRest(); else player.frame = 0;
  render();
});

el('dlGif').onclick  = downloadGif;
el('dlApng').onclick = downloadApng;
el('dlWebm').onclick = ()=>recordVideo(videoMime('webm'), 'webm', 'dlWebm');
el('dlMp4').onclick  = ()=>recordVideo(videoMime('mp4'),  'mp4',  'dlMp4');

el('dlPng').onclick  = ()=>download('image/png','png');
el('dlWebp').onclick = ()=>download('image/webp','webp');
el('dlAvif').onclick = ()=>download('image/avif','avif');
el('copy').onclick = async ()=>{
  try{
    const blob = await new Promise(r=>exportCanvas().toBlob(r,'image/png'));
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
    say('Copied to clipboard');
  }catch(err){ say('Clipboard blocked — use download'); }
};

atlas.onload = ()=>{
  buildIndexed();
  loadSaved();
  renderSaved();
  el('saveNote').hidden = false;
  if(!STORAGE_OK){
    el('savePal').disabled = true;
    el('saveName').disabled = true;
    el('saveNote').textContent = 'This page is running from an origin where the browser '
      + 'blocks local storage, so presets cannot be kept here. It works on the deployed site.';
  }
  FONT_BASE = PALETTE.slice(1, FONT_SLOTS+1).map(c=>c.slice());
  PALETTES.classic = FONT_BASE;
  SUP.webp = supports('image/webp');
  SUP.avif = supports('image/avif');
  if(!SUP.webp) el('dlWebp').title = "This browser can't encode WebP";
  if(!SUP.avif) el('dlAvif').title = "This browser can't encode AVIF";
  // the scene background shares the font's palette, so it must index after it
  // both scenes share the font's palette, so they must be indexed after it
  const ids = Object.keys(SCENES);
  let pending = ids.length;
  const done = ()=>{ if(--pending === 0){ ready = true; render(); } };
  for(const id of ids){
    const spec = SCENES[id].intro;
    if(spec){
      const parts = [spec.back, ...spec.front, spec.egg, spec.sonic, spec.mtn];
      for(const h of spec.hands || []) for(const q of h.patches) if(q) parts.push(q);
      let left = parts.length;
      pending++;
      for(const part of parts){
        const im = new Image();
        im.onload = im.onerror = ()=>{ part.img = im; if(--left === 0){ buildIntro(id); done(); } };
        im.src = part.src;
      }
    }
    const img = new Image();
    img.onload  = ()=>{ bgImgs[id] = img; buildBackground(id); done(); };
    img.onerror = ()=>{ const b = el('scene').querySelector(`button[data-scene="${id}"]`);
                        if(b) b.disabled = true; done(); };
    bgImgs[id] = img;
    img.src = SCENES[id].src;
  }
};
atlas.src = ATLAS_SRC;
