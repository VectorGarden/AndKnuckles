/*
Package aiz builds the Angel Island Zone intro: the Tornado over the ocean,
Super Sonic, the beach, Knuckles and the emeralds -- from the first frame of
AIZ1 to the frame before control is handed to the player. It is
tools/build-aiz-assets.mjs.

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
Labels and line numbers are sonic3k.asm in sonicretro/skdisasm.
*/
package aiz

import (
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

func s16(v int) int { return ((v & 0xFFFF) ^ 0x8000) - 0x8000 }

func u16(b []byte, i int) int { return int(b[i])<<8 | int(b[i+1]) }

// table finds a parsed mapping table by name.
func table(ts []lib.NamedFrames, name string) []lib.Frame {
	for _, t := range ts {
		if t.Name == name {
			return t.Frames
		}
	}
	panic("no mapping table " + name)
}

func dplcTable(ts []lib.NamedWords, name string) [][]int {
	for _, t := range ts {
		if t.Name == name {
			return t.Frames
		}
	}
	panic("no DPLC table " + name)
}

// level is the level, as LevelLoadBlock entry 0 loads it for the intro.
type level struct {
	vram, blocks, chunks, layout, coll, heights []byte
	fgW, bgW                                    int
}

// chunkWord is the chunk word at a world pixel (Find_Tile_FG): row pointers
// every 4 bytes, FG then BG, one chunk byte per column.
func (l *level) chunkWord(x, y int, bg bool) int {
	off, w := 0, l.fgW
	if bg {
		off, w = 2, l.bgW
	}
	p := u16(l.layout, 8+((y>>5)&0x7C)+off)
	if p == 0 {
		return 0
	}
	ch := int(l.layout[p-0x8000+(x>>7)%w])
	return u16(l.chunks, ch*0x80+(y&0x70)+((x>>3)&0xE))
}

// pattern is the nametable word drawn at a pixel: the block's quarter, with the
// chunk's flips folded in the way Setup_TileRowDraw does.
func (l *level) pattern(x, y int, bg bool) int {
	w := l.chunkWord(x, y, bg)
	b := w & 0x3FF
	qx, qy := (x>>3)&1, (y>>3)&1
	if w&0x400 != 0 {
		qx ^= 1
	}
	if w&0x800 != 0 {
		qy ^= 1
	}
	pw := u16(l.blocks, b*8+(qy*2+qx)*2)
	if w&0x400 != 0 {
		pw ^= 0x800
	}
	if w&0x800 != 0 {
		pw ^= 0x1000
	}
	return pw
}

// layers is a plane region as two index layers, and the tiles it uses in order.
type layers struct {
	lo, hi []byte
	tiles  []int
}

// renderPlane is a plane region as two index layers, low and high priority.
func (l *level) renderPlane(bg bool, x0, y0, w, h int) layers {
	lo, hi := make([]byte, w*h), make([]byte, w*h)
	var tiles []int
	seen := map[int]bool{}
	for ty := y0 &^ 7; ty < y0+h; ty += 8 {
		for tx := x0 &^ 7; tx < x0+w; tx += 8 {
			pw := l.pattern(tx, ty, bg)
			t := pw & 0x7FF
			hf, vf, line := (pw>>11)&1, (pw>>12)&1, (pw>>13)&3
			out := lo
			if pw&0x8000 != 0 {
				out = hi
			}
			if t != 0 && !seen[t] {
				seen[t] = true
				tiles = append(tiles, t)
			}
			for y := 0; y < 8; y++ {
				for x := 0; x < 8; x++ {
					X, Y := tx+x-x0, ty+y-y0
					if X < 0 || X >= w || Y < 0 || Y >= h {
						continue
					}
					sx, sy := x, y
					if hf != 0 {
						sx = 7 - x
					}
					if vf != 0 {
						sy = 7 - y
					}
					b := l.vram[t*32+sy*4+(sx>>1)]
					c := b >> 4
					if sx&1 != 0 {
						c = b & 15
					}
					if c != 0 {
						out[Y*w+X] = byte(line*16) + c
					}
				}
			}
		}
	}
	return layers{lo, hi, tiles}
}

// probe is the floor distance below a point (FindFloor, top-solid path 1, S3
// collision): negative means the point is inside the floor by that much.
func (l *level) probe(x, y int, full bool) int {
	w := l.chunkWord(x, y, false)
	b := w & 0x3FF
	empty := func() int {
		if full {
			return l.probe(x, y+16, false) + 16
		}
		return 0xF - (y & 0xF)
	}
	if b == 0 || (w>>0xC)&1 == 0 || 1+2*b >= len(l.coll) {
		return empty()
	}
	ci := int(l.coll[1+2*b])
	if ci == 0 {
		return empty()
	}
	hx := x
	if w&0x400 != 0 {
		hx = ^x
	}
	hi := ci*16 + (hx & 0xF)
	if hi >= len(l.heights) {
		return empty()
	}
	h := int(l.heights[hi])
	if h > 127 {
		h -= 256
	}
	if w&0x800 != 0 {
		h = -h
	}
	if h == 0 {
		return empty()
	}
	if h < 0 {
		if (y&0xF)+h >= 0 {
			return empty()
		}
		if full {
			return l.probe(x, y-16, false) - 16
		}
		return 0xF - (y & 0xF)
	}
	if h == 16 && full {
		return l.probe(x, y-16, false) - 16
	}
	return 0xF - ((y & 0xF) + h)
}

// dplcArt: DPLC frames load runs of tiles into the object's VRAM slot; mapping
// tiles index into what was loaded. Sonic_Load_PLC packs (count-1)<<12 | tile;
// Perform_DPLC (Knuckles) packs tile<<4 | (count-1).
func dplcArt(src []byte, entries []int, sonicStyle bool) []byte {
	var out []byte
	for _, e := range entries {
		n, t := (e&15)+1, e>>4
		if sonicStyle {
			n, t = (e>>12)+1, e&0xFFF
		}
		a, b := min(t*32, len(src)), min((t+n)*32, len(src))
		out = append(out, src[a:b]...)
	}
	return out
}

// sprite is one distinct sprite frame, and where the atlas put it.
type sprite struct {
	key string
	*lib.Rendered
	ax, ay int
}

// Obj is an object: positions are 16.16 fixed point, velocities 8.8. The JS
// adds whatever fields each routine needs; here they are all on one struct.
type Obj struct {
	x, y, xv, yv int
	alive        bool

	r, w2E, w40, w3A, at, af, ai, mf, base int
	acc, mx                                int
	b0, flip, onscreen                     bool
	b38                                    [4]bool
	frame                                  sprFrame
	mode, then, state                      string
	born, died, shown, lastFrame           int
	sub, i, start                          int
	air, started                           bool
	f0, landed                             int
}

type sprFrame struct {
	table string
	f     int
}

func newObj(x, y int) *Obj { return &Obj{x: x * 65536, y: y * 65536, alive: true} }

func (o *Obj) X() int     { return s16(o.x >> 16) }
func (o *Obj) Y() int     { return s16(o.y >> 16) }
func (o *Obj) setX(v int) { o.x = s16(v)*65536 + (o.x - (o.x>>16)*65536) }
func (o *Obj) setY(v int) { o.y = s16(v)*65536 + (o.y - (o.y>>16)*65536) }

// move2 is MoveSprite2.
func move2(o *Obj) { o.x += o.xv * 256; o.y += o.yv * 256 }

// move is MoveSprite.
func move(o *Obj) int { o.x += o.xv * 256; old := o.yv; o.yv += 0x38; o.y += old * 256; return old }

// swing is Swing_UpAndDown.
func swing(o *Obj) {
	d := o.yv
	if !o.b0 {
		d -= o.acc
		if d > -o.mx {
			o.yv = d
			return
		}
		o.b0 = true
	}
	d += o.acc
	if d < o.mx {
		o.yv = d
		return
	}
	o.b0 = false
	o.yv = d - o.acc
}

// K_ANIM: Animate_Raw / Animate_RawNoSST over Knuckles' scripts, laid out
// contiguously as they are in the ROM, since a leftover index can read across them.
var K_ANIM = []int{1, 0x12, 0x13, 0x14, 0x15, 0xFC, 1, 8, 4, 8, 5, 8, 6, 8, 7, 0xFC, 7, 0x1C, 0x1C, 0x1D, 0xF8, 6, 7, 0x1E, 0x1F, 0xFC}

func animRaw(o *Obj) {
	if o.at--; o.at >= 0 {
		return
	}
	o.ai++
	if o.base+1+o.ai >= len(K_ANIM) {
		return // undefined in the JS: no case matches
	}
	v := K_ANIM[o.base+1+o.ai]
	if v < 0x80 {
		o.at = K_ANIM[o.base]
		o.mf = v
		return
	}
	if v == 0xFC {
		o.mf = K_ANIM[o.base+1]
		o.at = K_ANIM[o.base]
		o.ai = 0
		return
	}
	if v == 0xF8 {
		o.base += K_ANIM[o.base+2+o.ai]
		o.mf = K_ANIM[o.base+1]
		o.at = K_ANIM[o.base]
		o.ai = 0
	}
}

var (
	BALL     = []int{0x97, 0x96, 0x98, 0x96, 0x99, 0x96, 0x9A, 0x96} // byte_67A84
	WAVE     = []int{0, 1, 0, 0, 1, 1, 2, 2, 3, 2, 4, 1, 5, 1, 0xF4} // byte_67A9B, (frame,delay) pairs
	PROP_A   = []int{2, 3, 4, 3, 2, 1}                               // byte_67A8F as shown
	PROP_B   = []int{6, 5}                                           // byte_67A97 as shown
	EMER_VEL = [][2]int{{-0x40, -0x700}, {-0x80, -0x700}, {-0x180, -0x700}, {-0x100, -0x700}, {-0x200, -0x700}, {-0x280, -0x700}, {-0x300, -0x700}}
	ROCK_VEL = [][2]int{{-0x100, -0x200}, {0x100, -0x200}, {-0xE0, -0x1C0}, {0xE0, -0x1C0}, {-0xC0, -0x180}, {0xC0, -0x180},
		{-0xA0, -0x140}, {0xA0, -0x140}, {-0x80, -0x100}, {0x80, -0x100}, {-0x60, -0xC0}, {0x60, -0xC0}} // word_2A8B0
)

const CAM_Y = 0x390

// Tables that live in the code rather than in data files (sonic3k.asm L3985-4040, L4865).
var (
	PalAIZ1_1 = []int{0xEE8, 0xEE2, 0xEA4, 0xE64, 0xEE2, 0xEA4, 0xE64, 0xEE8, 0xEA4, 0xE64, 0xEE8, 0xEE2, 0xE64, 0xEE8, 0xEE2, 0xEA4}
	PalAIZ1_3 = []int{0xEEC, 0xEEE, 0xEE8, 0xE40, 0xEEC, 0xEE8, 0xEE8, 0xEEE, 0xEEA, 0xE86, 0xEE8, 0xEE8, 0xEE8, 0xE40, 0xEE8, 0xE86,
		0xEE6, 0xEEE, 0xEE8, 0xE40, 0xEEA, 0xEE8, 0xEE8, 0xEEE, 0xEE8, 0xE86, 0xEE8, 0xEE8, 0xEE8, 0xE40, 0xEE8, 0xE86,
		0xEE6, 0xEEE, 0xEE8, 0xE40, 0xEE8, 0xEE8, 0xEE8, 0xEEE}
	PalAIZ1_4 = []int{0xCEC, 0xCEE, 0xEEE, 0xCEE, 0xEEE, 0xEEE, 0xEEE, 0xEEE, 0xEEE, 0xEEE, 0xEEE, 0xEEE, 0xEEE, 0xEEE, 0xEEE,
		0xEEE, 0xEEE, 0xEEE, 0xEEE, 0xEEE, 0xEEE, 0xEE8, 0xEEE, 0xEEE, 0xEE8, 0xEE8, 0xEEE, 0xEE8, 0xEE8, 0xEE8}
	// AnPal_PalAIZ1_2, followed by the start of AnPal_PalAIZ2_1: the counter can be
	// left at $36 by the intro branch, and the read overruns into it once.
	PalAIZ1_2 = []int{0xEA4, 0xE60, 0xEE2, 0xEA4, 0xEE8, 0xEA4, 0xE60, 0xEE8, 0xEEE, 0xE60, 0xEE2, 0xEE2,
		0xEE8, 0xEA4, 0xEA4, 0xEE2, 0xE60, 0xE60, 0xEE2, 0xE60, 0xEEE, 0xEE2, 0xE60, 0xEE8,
		0xEE8, 0xEE2, 0xEC4, 0xEA4, 0xEE2, 0xEC4, 0xEA4, 0xEE8}
	SUPER = [][3]int{{0xE66, 0xC42, 0x822}, {0xE88, 0xC66, 0x844}, {0xEAA, 0xC88, 0xA66}, {0xECC, 0xEAA, 0xC88}, {0xEEE, 0xECC, 0xEAA},
		{0xEEE, 0xEEE, 0xEEE}, {0xCEE, 0xCEE, 0xAEE}, {0xAEE, 0x8EE, 0x6CC}, {0x8EE, 0x0EE, 0x0AA}, {0xAEE, 0x8EE, 0x6CC}}
)

// AIZ1_IntroDeform: band 0 (80 sky lines) at d0 = v/2, then 36 bands of 4 lines
// interpolating towards $580 -- lower lines further, a perspective ocean.
func bands(v int) []int {
	d0, e := v>>1, make([]int, 37)
	if d0 >= 0x580 {
		for i := range e {
			e[i] = d0
		}
		return e
	}
	e[0] = d0
	acc := int32(uint32((d0-0x580)&0xFFFF) << 16) // int32, low word 0
	step := acc >> 5
	for i := 1; i <= 36; i++ {
		acc += step
		e[i] = s16(int(acc>>16)) + 0x580
	}
	return e
}

// sprEntry is one sprite drawn on a frame.
type sprEntry struct{ id, sx, sy, bucket, slot int }

// frame is one timeline entry.
type frame struct {
	f, cam, bg, p int
	pal           []int
	spr           [][3]int
}

// Build writes the AIZ intro's assets into out.
func Build(out string) {
	out = lib.OutDir(out)
	rd := lib.Rom

	// ---- the level, as LevelLoadBlock entry 0 loads it for the intro ------------
	// Secondary tiles go straight after Primary's (tile $BE); Secondary blocks are
	// appended to Primary's. Chunks are one file. Block entries hold absolute tiles.
	tilesP := lib.KosMDecode(rd("AIZ1_Tiles_Primary.kosm"))
	tilesS := lib.KosMDecode(rd("AIZ1_Tiles_Secondary.kosm"))
	if len(tilesP) != 0xBE*32 {
		panic("primary tiles are not $BE tiles")
	}
	L := &level{vram: make([]byte, 0x800*32)}
	copy(L.vram, tilesP)
	copy(L.vram[len(tilesP):], tilesS)
	bp, _ := lib.KosDecode(rd("AIZ1_Blocks_Primary.kos"), 0)
	bs, _ := lib.KosDecode(rd("AIZ1_Blocks_Secondary.kos"), 0)
	L.blocks = append(append([]byte(nil), bp...), bs...)
	L.chunks, _ = lib.KosDecode(rd("AIZ1_Chunks.kos"), 0)
	L.layout = rd("AIZ1_Layout.bin")
	L.coll, L.heights = rd("AIZ1_Collision.bin"), rd("Height_Maps.bin")
	L.fgW, L.bgW = u16(L.layout, 0), u16(L.layout, 2)
	vram := L.vram

	// ---- sprites ----------------------------------------------------------------
	sonicMaps := lib.ParseMapTables(string(rd("Sonic_map.asm")))
	sonicDplc := lib.ParseDplcTables(string(rd("Sonic_dplc.asm")))
	knuxMap := table(lib.ParseMapTables(string(rd("Knux_Cutscene_map.asm"))), "Map_CutsceneKnux")
	knuxDplc := dplcTable(lib.ParseDplcTables(string(rd("Knux_Cutscene_dplc.asm"))), "DPLC_CutsceneKnux")
	planeMap := lib.ParseMapTables(string(rd("AIZ_IntroPlane_map.asm")))[0].Frames
	waveMap := lib.ParseMapTables(string(rd("AIZ_IntroWaves_map.asm")))[0].Frames
	emerMap := lib.ParseMapTables(string(rd("AIZ_IntroEmeralds_map.asm")))[0].Frames
	rockMap := lib.ParseMapTables(string(rd("AIZ_CorkFloor_map.asm")))[0].Frames
	sonicArt, knuxArt := rd("Sonic.unc"), rd("Knux_Cutscene.unc")
	planeArt := lib.KosMDecode(rd("AIZ_IntroPlane.kosm"))
	emerArt := lib.KosMDecode(rd("AIZ_IntroEmeralds.kosm"))
	waveArt := lib.NemDecode(rd("AIZ_IntroWaves.nem"))

	var SPRITES []*sprite
	spriteIds := map[string]int{}
	spr := func(key string, mk func() *lib.Rendered) int {
		if _, ok := spriteIds[key]; !ok {
			f := mk()
			if f != nil {
				spriteIds[key] = len(SPRITES)
				SPRITES = append(SPRITES, &sprite{key: key, Rendered: f})
			} else {
				spriteIds[key] = -1
			}
		}
		return spriteIds[key]
	}
	sonicFrame := func(fr sprFrame) int {
		return spr(fmt.Sprintf("%s:%d", fr.table, fr.f), func() *lib.Rendered {
			plc := "PLC_SuperSonic"
			if fr.table == "Map_Sonic" {
				plc = "PLC_Sonic"
			}
			return lib.RenderFrame(table(sonicMaps, fr.table)[fr.f], dplcArt(sonicArt, dplcTable(sonicDplc, plc)[fr.f], true), lib.RenderOpts{})
		})
	}
	knuxFrame := func(f int, flip bool) int {
		fl := 0
		if flip {
			fl = 1
		}
		return spr(fmt.Sprintf("knux:%d:%d", f, fl), func() *lib.Rendered {
			return lib.RenderFrame(knuxMap[f], dplcArt(knuxArt, knuxDplc[f], false), lib.RenderOpts{Line: 1, Hflip: flip})
		})
	}
	planeFrame := func(f int) int {
		return spr(fmt.Sprintf("plane:%d", f), func() *lib.Rendered { return lib.RenderFrame(planeMap[f], planeArt, lib.RenderOpts{}) })
	}
	waveFrame := func(f int) int {
		return spr(fmt.Sprintf("wave:%d", f), func() *lib.Rendered { return lib.RenderFrame(waveMap[f], waveArt, lib.RenderOpts{Hflip: true}) })
	}
	emerFrame := func(f int) int {
		return spr(fmt.Sprintf("emer:%d", f), func() *lib.Rendered { return lib.RenderFrame(emerMap[f], emerArt, lib.RenderOpts{Line: 3}) })
	}
	// Map_AIZCorkFloor at make_art_tile($001,2,0): level tiles from 1, line 2.
	rockFrame := func() int {
		return spr("rock", func() *lib.Rendered { return lib.RenderFrame(rockMap[0], vram, lib.RenderOpts{Base: 1, Line: 2}) })
	}
	// BreakObjectToPieces: each piece of frame 1 its own object, art_tile | high_priority.
	rockPiece := func(i int) int {
		return spr(fmt.Sprintf("rock:%d", i), func() *lib.Rendered {
			return lib.RenderFrame(lib.Frame{rockMap[1][i]}, vram, lib.RenderOpts{Base: 1, Line: 2, Pri: 1})
		})
	}

	// ---- palettes ---------------------------------------------------------------
	palSonic := lib.Words(rd("Pal_SonicTails.bin"))[:16]
	palIntro := lib.Words(rd("AIZ_Pal_Intro.bin")) // lines 2-4
	palMain := lib.Words(rd("AIZ_Pal_Main.bin"))
	palEmer := lib.Words(rd("AIZ_Pal_IntroEmeralds.bin"))
	palKnux := lib.Words(rd("Knux_Cutscene_Pal.bin"))
	if len(palIntro) != 48 || len(palMain) < 48 {
		panic("unexpected AIZ palette sizes")
	}
	// pal.splice(at, n, ...src) keeps the array's length only when len(src) == n.
	splice := func(pal []int, at, n int, src []int) []int {
		return slices.Concat(pal[:at], src, pal[at+n:])
	}

	// ---- the simulation -----------------------------------------------------------
	// A port of a line-by-line transcription of the routines; see the README for
	// the timeline it produces. Positions are 16.16 fixed point; velocities 8.8.
	ev1 := (0xE918 + 8) & 0xFFFF // Events_fg_1 after P's init frame
	px := 0x40                   // Player_1 x while hidden; y stays $420
	const PY = 0x420
	camX, camMin, resize, cycFlag := 0, 0, 0, 1
	P := newObj(0x60, 0x30)
	P.r, P.w2E, P.w40, P.frame = 2, 0x40, 8, sprFrame{"Map_Sonic", 0xBA}
	var plane, knux, rock, PL *Obj
	deleted := false
	var waves, emer, pieces []*Obj
	var events []string
	ev := func(f int, s string) { events = append(events, fmt.Sprintf("F%d: %s", f, s)) }

	spawnWave := func(f int) {
		w := newObj(P.X(), P.Y()+0x18)
		w.born = f
		waves = append(waves, w)
	}
	waitP := func() bool { P.w2E--; return P.w2E < 0 } // Obj_Wait
	waveTick := func(f int) {
		if waitP() {
			P.w2E = 5
			if P.X()&0xFFFF >= 0x80 {
				spawnWave(f)
			}
		}
	}
	stepP := func(f int) {
		switch P.r {
		case 2:
			if waitP() {
				P.r, P.xv, P.yv = 4, 0x300, 0x600
				plane = newObj(P.X()-0x22, P.Y()+0x2C)
				plane.yv, plane.mx, plane.acc, plane.mode, plane.born = 0xC0, 0xC0, 0x10, "attached", f
				ev(f, "the Tornado flies in")
			}
		case 4:
			P.yv -= 0x18
			if P.yv == 0 {
				P.r, P.xv, P.w2E, P.yv, P.mx, P.acc, P.w40, P.b0 = 6, 0, 0x5F, 0xC0, 0xC0, 0x10, 0x10, false
			} else {
				move2(P)
			}
		case 6:
			swing(P)
			move2(P)
			if waitP() {
				P.r, P.xv, P.yv = 8, 0x400, -0x400
				P.b38[3] = true
				P.at, P.af = 0, 0
				ev(f, "Sonic jumps off")
			}
		case 8:
			P.xv -= 0x40
			move(P)
			if P.Y() >= 0x130 {
				P.r, P.y, P.yv = 0xA, 0x130*65536, 0
			} else if P.at--; P.at < 0 {
				P.at = 3
				P.af = (P.af + 1) % 8
				P.frame = sprFrame{"Map_Sonic", BALL[P.af]}
			}
		case 0xA:
			P.xv -= 0x40
			move2(P)
			if P.X()&0xFFFF < 0x40 {
				P.r = 0xC
				P.setX(0x40)
				P.w2E, P.w3A, P.frame = 5, 0x3F, sprFrame{"Map_SuperSonic", 0x21}
				ev(f, "Super Sonic (off-screen)")
			}
		case 0xC:
			if P.w3A--; P.w3A < 0 {
				P.r = 0xE
			}
		case 0xE, 0x10, 0x12, 0x14:
			waveTick(f)
			switch P.r {
			case 0xE:
				P.setX(P.X() + 4)
				if P.X()&0xFFFF >= 0x200 {
					P.r, P.w3A = 0x10, 0x1F
				}
			case 0x10:
				if P.w3A--; P.w3A < 0 {
					P.r = 0x12
					P.b38[2] = true
					P.w40 = 0xC
				}
			case 0x12:
				P.setX(P.X() - 4)
				if P.X()&0xFFFF <= 0x120 {
					P.r, P.w3A, P.w40 = 0x14, 0x1F, 0x10
				}
			default:
				if P.w3A--; P.w3A < 0 {
					P.r = 0x16
				}
			}
		case 0x16:
			if px >= 0x918 {
				P.r = 0x18
				knux = newObj(0x1400, 0x440)
				knux.r, knux.mf, knux.base, knux.born = 2, 8, 6, f
				rock = newObj(0x1400, 0x458)
				rock.born = f
				ev(f, "Knuckles is buried at ($1400,$440)")
			} else {
				waveTick(f)
			}
		case 0x18:
			if px >= 0x1240 {
				P.r = 0x1A
				P.setY(P.Y() - 0x20)
			}
		case 0x1A:
			if px >= 0x13D0 {
				PL = newObj(px, PY)
				PL.xv, PL.yv, PL.air, PL.f0 = -0x200, -0x400, true, f
				for i, v := range EMER_VEL {
					e := newObj(px, PY)
					e.sub, e.xv, e.yv, e.state = 2*i, v[0], v[1], "fly"
					emer = append(emer, e)
				}
				ev(f, "knockback")
			}
		}
		if P.r >= 0xE && P.r <= 0x1A { // sub_679B8
			fr := 0x21
			if (f>>1)&1 != 0 {
				fr = 0x22
			}
			P.frame = sprFrame{"Map_SuperSonic", fr}
		}
	}
	stepPlane := func(f int) {
		if plane == nil || !plane.alive {
			return
		}
		swing(plane)
		move2(plane)
		if plane.mode == "attached" {
			if P.b38[2] {
				plane.mode = "leaving"
			}
			if !P.b38[3] {
				plane.setX(P.X() - 0x22)
				plane.setY(P.Y() + 0x2C)
			}
		} else {
			plane.setX(plane.X() - 4)
			if plane.X()&0xFFFF < 0x20 {
				plane.alive, plane.died = false, f
			}
		}
	}
	stepWaves := func(f int) {
		for _, w := range waves {
			if !w.alive {
				continue
			}
			if w.X()&0xFFFF < 0x60 {
				w.alive = false
				continue
			}
			w.setX(w.X() - P.w40)
			if w.at--; w.at < 0 {
				w.ai += 2
				if WAVE[w.ai] == 0xF4 {
					w.alive = false
					continue
				}
				w.mf, w.at = WAVE[w.ai], WAVE[w.ai+1]
			}
			w.shown = f
		}
	}
	stepKnux := func(f int) {
		k := knux
		if k == nil || !k.alive {
			return
		}
		switch k.r {
		case 2:
			if PL != nil {
				k.r, k.yv, k.xv, k.base = 4, -0x600, 0x80, 6
			}
		case 4:
			animRaw(k)
			old := move(k)
			if old >= 0 {
				if d := L.probe(k.X(), k.Y()+0x13, true); d < 0 {
					k.setY(k.Y() + d)
					k.r, k.mf, k.w2E = 6, 0x16, 0x7F
					ev(f, "Knuckles lands")
				}
			}
		case 6:
			if k.w2E--; k.w2E < 0 {
				k.r, k.flip, k.base, k.xv, k.yv, k.w2E, k.then = 8, !k.flip, 0, -0x600, 0, 0x29, "reverse"
				animRaw(k)
				move2(k)
				k.w2E--
			}
		case 8:
			animRaw(k)
			move2(k)
			if k.w2E--; k.w2E < 0 {
				if k.then == "reverse" {
					k.xv, k.flip, k.w2E, k.then = -k.xv, !k.flip, 0x29, "stop"
				} else {
					k.r, k.mf, k.w2E, k.base, k.at, k.ai = 0xA, 0x1C, 0x3F, 16, 0, 0
					ev(f, "Knuckles laughs")
				}
			}
		case 0xA:
			animRaw(k)
			if k.w2E--; k.w2E < 0 {
				k.r, k.base, k.xv = 0xC, 0, 0x600
			}
		case 0xC:
			if k.onscreen {
				animRaw(k)
				move2(k)
			} else {
				k.alive = false
				ev(f, "Knuckles is gone: end of the cutscene")
			}
		}
	}
	stepEmeralds := func(f int) {
		for _, e := range emer {
			if !e.alive {
				continue
			}
			if e.state == "fly" {
				old := move(e)
				if old >= 0 {
					if d := L.probe(e.X(), e.Y()+4, true); d < 0 {
						e.setY(e.Y() + d)
						e.state = "rest"
					}
				}
			} else if knux != nil && knux.alive {
				lo := (e.X() - 8) & 0xFFFF
				if knux.X() >= lo && knux.X() < lo+16 {
					v := knux.xv
					if e.sub&2 != 0 {
						v = -knux.xv
					}
					if v >= 0 {
						e.alive = false
						ev(f, fmt.Sprintf("emerald %d taken", e.sub/2))
					}
				}
			}
		}
	}
	stepPlayer := func(f int) {
		if PL == nil || !PL.started || !PL.air {
			return
		}
		move2(PL)
		PL.yv += 0x30
		a := int(lib.Round(lib.Atan2(float64(PL.yv), float64(PL.xv))/(2*math.Pi)*256)) & 0xFF
		q := (a - 0x20) & 0xC0
		if (q == 0x00 || q == 0x40) && PL.yv >= 0 {
			d1, d2 := L.probe(PL.X()+9, PL.Y()+0x13, true), L.probe(PL.X()-9, PL.Y()+0x13, true)
			dmin, dmax := min(d1, d2), max(d1, d2)
			land := false
			if dmin < 0 {
				if q == 0x40 {
					land = true
				} else {
					thr := -(((PL.yv >> 8) & 0xFF) + 8)
					land = dmin >= thr || dmax >= thr
				}
			}
			if land {
				PL.setY(PL.Y() + dmin)
				PL.air, PL.xv, PL.yv, PL.landed = false, 0, 0, f
				ev(f, "Sonic lands")
			}
		}
		nx := s16((PL.x + PL.xv*256) >> 16)
		if nx < camMin+0x10 {
			PL.setX(camMin + 0x10)
			PL.xv = 0
		}
	}
	stepPieces := func(f int) {
		for _, p := range pieces {
			if !p.alive || p.start > f {
				continue
			}
			move2(p)
			p.yv += 0x18 // loc_2A5F8
			if !p.onscreen {
				p.alive = false
			}
		}
	}
	camera := func() string {
		x := px
		if PL != nil {
			x = PL.X()
		}
		d := x - camX - 0x90
		if d < 0 {
			camX = max(camX+max(d, -0x18), camMin)
		} else if d -= 0x10; d >= 0 {
			camX = min(camX+min(d, 0x18), 0x6000)
		}
		if resize == 0 { // AIZ1_Resize
			if camX >= 0x1000 {
				cycFlag, camMin = 0, camX
				if camX >= 0x1308 {
					resize = 2
					return "aiz-palette"
				}
			}
		} else {
			camMin = 0x1308
		}
		return ""
	}

	// palette state
	pal := make([]int, 64)
	copy(pal, palSonic)
	c1, c0, cc2, cc0, pTimer, pFrame, sStat := 0, 0, 0, 0, 0, 0x24, 0
	palFade := func() { // Pal_FromBlack over lines 2-4
		for i := 16; i < 64; i++ {
			cur, tgt := pal[i], palIntro[i-16]
			if cur == tgt {
				continue
			}
			if cur+0x200 <= tgt {
				pal[i] = cur + 0x200
			} else if cur+0x20 <= tgt {
				pal[i] = cur + 0x20
			} else {
				pal[i] = cur + 2
			}
		}
	}
	palCycle := func(f int) { // Animate_Palette, before the objects
		if f <= 22 {
			palFade()
			return
		}
		if sStat == 2 { // SuperHyper_PalCycle_Revert
			if pTimer--; pTimer < 0 {
				pTimer = 3
				d := pFrame
				pFrame -= 6
				if pFrame < 0 {
					sStat, pFrame = 0, 0
				}
				copy(pal[2:], SUPER[d/6][:])
			}
		}
		if c1--; c1 >= 0 {
			return
		}
		if cycFlag != 0 { // AnPal_AIZ1, intro branch
			c1 = 9
			d := c0
			if c0 += 8; c0 >= 0x50 {
				c0 = 0
			}
			for i := 0; i < 4; i++ {
				pal[48+2+i] = PalAIZ1_3[d/2+i]
			}
			e := cc2
			if cc2 += 6; cc2 >= 0x3C {
				cc2 = 0
			}
			for i := 0; i < 3; i++ {
				pal[48+0xD+i] = PalAIZ1_4[e/2+i]
			}
		} else { // normal branch
			c1 = 7
			d := c0 & 0x18
			c0 += 8
			for i := 0; i < 4; i++ {
				pal[32+0xB+i] = PalAIZ1_1[d/2+i]
			}
			if cc0 == 0 {
				e := cc2
				if cc2 += 6; cc2 >= 0x30 {
					cc2 = 0
				}
				for i := 0; i < 3; i++ {
					pal[48+0xC+i] = PalAIZ1_2[e/2+i]
				}
			}
		}
	}
	superCycle := func() { // sub_679B8's palette half
		if pTimer--; pTimer >= 0 {
			return
		}
		pTimer = 6
		d := pFrame
		if pFrame += 6; pFrame >= 0x36 {
			pFrame = 0x24
		}
		copy(pal[2:], SUPER[d/6][:])
	}

	// ---- run it --------------------------------------------------------------------
	// Painter's order: Render_Sprites emits priority buckets front to back and, in a
	// bucket, objects in slot order, and the first sprite emitted wins -- so draw the
	// highest bucket first and, within one, the latest slot first.
	var timeline []*frame
	F := 1
	for ; F < 1400; F++ {
		palCycle(F)
		stepPlayer(F)
		if !deleted {
			stepP(F)
			if P.r >= 0xE && P.r <= 0x1A {
				superCycle()
			}
			if ev1&0x8000 != 0 { // sub_67A08
				ev1 = (ev1 + P.w40) & 0xFFFF
			} else {
				px += P.w40
			}
			if PL != nil && !PL.started {
				// P still pushed the player this frame, then is deleted (Go_Delete_Sprite)
				deleted = true
				PL.setX(px)
				for _, e := range emer {
					e.setX(px)
				}
				pal = splice(pal, 48, 16, palEmer) // Pal_AIZIntroEmeralds -> line 4
				cc0, sStat, pFrame = 0xFF, 2, 0x1E
				P.lastFrame = F
			}
		}
		stepPlane(F)
		stepWaves(F)
		kBefore := -1
		if knux != nil {
			kBefore = knux.r
		}
		stepKnux(F)
		if knux != nil && kBefore == 2 && knux.r == 4 {
			pal = splice(pal, 16, 16, palKnux) // Pal_CutsceneKnux -> line 2
		}
		// the rock watches Knuckles' status bit: frame 1's pieces fly the same frame
		if rock != nil && rock.alive && knux != nil && knux.r != 2 {
			rock.alive = false
			for i := range rockMap[1] {
				p := newObj(rock.X(), rock.Y())
				p.i, p.xv, p.yv, p.start, p.onscreen = i, ROCK_VEL[i][0], ROCK_VEL[i][1], F, true
				if i == 0 {
					p.start = F + 1
				}
				pieces = append(pieces, p)
			}
		}
		stepPieces(F)
		stepEmeralds(F)
		if camera() == "aiz-palette" {
			pal = splice(pal, 16, 48, palMain[:48]) // LoadPalette_Immediate(PalID_AIZ)
		}
		if PL != nil && !PL.started {
			PL.started = true
		}
		if knux != nil && knux.alive {
			sx := knux.X() - camX
			knux.onscreen = sx+0x1C >= 0 && sx-0x1C < 320
		}
		if knux != nil && !knux.alive {
			break
		}

		// ---- what is on screen this frame ----
		var sp []sprEntry
		add := func(id, sx, sy, bucket, slot int) {
			if id >= 0 {
				sp = append(sp, sprEntry{id, sx, sy, bucket, slot})
			}
		}
		scr := func(o *Obj, id, bucket, slot int) { add(id, o.X()-0x80, o.Y()-0x80, bucket, slot) }
		wld := func(o *Obj, id, bucket, slot int) { add(id, o.X()-camX, o.Y()-CAM_Y, bucket, slot) }
		if !deleted || P.lastFrame == F {
			scr(P, sonicFrame(P.frame), 5, 10)
		}
		if plane != nil && plane.alive && F > plane.born {
			scr(plane, planeFrame(0), 5, 11)
			k := F - plane.born - 1
			add(planeFrame(PROP_A[k%6]), plane.X()+0x38-0x80, plane.Y()+4-0x80, 5, 12)
			add(planeFrame(PROP_B[k%2]), plane.X()+0x18-0x80, plane.Y()+0x18-0x80, 5, 13)
		}
		for i, w := range waves {
			if w.alive && w.shown == F {
				scr(w, waveFrame(w.mf), 2, 20+i)
			}
		}
		if knux != nil && knux.alive {
			wld(knux, knuxFrame(knux.mf, knux.flip), 3, 11)
		}
		if rock != nil && rock.alive {
			wld(rock, rockFrame(), 3, 12)
		}
		for i, e := range emer {
			if e.alive {
				wld(e, emerFrame(i), 5, 13+i)
			}
		}
		if PL != nil {
			// anim $1A (frame $8D) through the knock-back; walk frame 7 on the landing
			// frame; then AniSonic05's $BA, behind Sonic_Display's 4-on/4-off flicker
			fr, show := 0x8D, F > PL.f0
			if PL.landed == F {
				fr = 7
			} else if PL.landed != 0 && F > PL.landed {
				fr = 0xBA
				if t := 120 - (F - PL.landed - 1); t > 0 {
					show = t&4 != 0
				}
			}
			if show {
				wld(PL, sonicFrame(sprFrame{"Map_Sonic", fr}), 2, 0)
			}
		}
		for _, p := range pieces {
			if !p.alive || p.start > F {
				continue
			}
			id := rockPiece(p.i)
			s := SPRITES[id]
			sx, sy := p.X()-camX+s.Ox, p.Y()-CAM_Y+s.Oy
			p.onscreen = sx+s.W > 0 && sx < 320 && sy+s.H > 0 && sy < 224
			bucket := 1
			if p.i != 0 {
				bucket = 0
			}
			wld(p, id, bucket, 30+p.i)
		}
		sort.SliceStable(sp, func(a, b int) bool {
			if sp[a].bucket != sp[b].bucket {
				return sp[a].bucket > sp[b].bucket
			}
			return sp[a].slot > sp[b].slot
		})
		bgv := camX
		if ev1&0x8000 != 0 {
			bgv = ev1
		}
		t := &frame{f: F, cam: camX, bg: s16(bgv), pal: slices.Clone(pal), spr: [][3]int{}}
		for _, s := range sp {
			t.spr = append(t.spr, [3]int{s.id, s.sx, s.sy})
		}
		timeline = append(timeline, t)
	}
	LAST := F - 1
	for _, e := range events {
		fmt.Println("  " + e)
	}
	for _, e := range emer {
		if e.alive {
			panic("not every emerald was collected -- the simulation has drifted")
		}
	}
	fmt.Printf("  %d frames, F1-F%d; %d distinct sprite frames\n", len(timeline), LAST, len(SPRITES))

	// ---- planes ---------------------------------------------------------------------
	// Plane A only over the camera's path; it is empty (chunk 0) below x $900.
	cams := make([]int, len(timeline))
	for i, t := range timeline {
		cams[i] = t.cam
	}
	fgX0, fgX1 := slices.Min(cams), slices.Max(cams)+320
	{
		W := fgX1 - fgX0
		probeFg := L.renderPlane(false, fgX0, CAM_Y, W, 224)
		filled := func(x int) bool {
			for y := 0; y < 224; y++ {
				if probeFg.lo[y*W+x] != 0 || probeFg.hi[y*W+x] != 0 {
					return true
				}
			}
			return false
		}
		first := 0
		for first < W && !filled(first) {
			first++
		}
		fgX0 += first &^ 7
	}
	fg := L.renderPlane(false, fgX0, CAM_Y, fgX1-fgX0, 224)

	// Negative scroll positions read the 512-px plane as init drew it, BG x 0-$1FF.
	bgX1 := 512
	for _, t := range timeline {
		for _, e := range bands(t.bg) {
			if e >= 0 {
				bgX1 = max(bgX1, e+320)
			}
		}
	}
	bgX1 = (bgX1 + 7) &^ 7
	bg := L.renderPlane(true, 0, CAM_Y, bgX1, 224)
	if slices.ContainsFunc(bg.hi, func(v byte) bool { return v != 0 }) {
		panic("plane B has high-priority tiles on screen; the page draws it as one layer")
	}

	// AnimateTiles_AIZ1 starts writing tiles $2E6-$303 at F755. Make sure none of
	// them are in what the camera can see from then on, or they would need frames.
	{
		var late []*frame
		for _, t := range timeline {
			if t.f >= 755 {
				late = append(late, t)
			}
		}
		lo, hi := math.MaxInt, math.MinInt
		for _, t := range late {
			lo, hi = min(lo, t.cam), max(hi, t.cam)
		}
		hi += 320
		type named struct {
			name  string
			tiles []int
		}
		seen := []named{{"plane A", L.renderPlane(false, lo, CAM_Y, hi-lo, 224).tiles}}
		for _, t := range late {
			done := map[int]bool{}
			for _, e := range bands(t.bg) {
				if done[e] {
					continue
				}
				done[e] = true
				x, w := e, 320
				if e < 0 {
					x, w = 0, 512
				}
				seen = append(seen, named{"plane B", L.renderPlane(true, x, CAM_Y, w, 224).tiles})
			}
		}
		for _, s := range seen {
			for _, t := range s.tiles {
				if t >= 0x2E6 && t <= 0x303 {
					panic(fmt.Sprintf("%s shows animated tile $%x after F755", s.name, t))
				}
			}
		}
	}

	// ---- write --------------------------------------------------------------------
	// Index layers: grey g*4 for palette index g, index 0 transparent.
	lib.WriteIdx(out, "aiz-fg.png", fg.lo, fgX1-fgX0, 224)
	lib.WriteIdx(out, "aiz-fg-hi.png", fg.hi, fgX1-fgX0, 224)
	lib.WriteIdx(out, "aiz-bg.png", bg.lo, bgX1, 224)

	// Shelf-pack the sprite frames.
	const AW = 512
	order := make([]int, len(SPRITES))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return SPRITES[order[a]].H > SPRITES[order[b]].H })
	ax, ay, shelf := 0, 0, 0
	for _, i := range order {
		s := SPRITES[i]
		if ax+s.W > AW {
			ax, ay, shelf = 0, ay+shelf, 0
		}
		s.ax, s.ay = ax, ay
		ax += s.W
		shelf = max(shelf, s.H)
	}
	AH := ay + shelf
	atlas := make([]byte, AW*AH)
	for _, s := range SPRITES {
		for y := 0; y < s.H; y++ {
			copy(atlas[(s.ay+y)*AW+s.ax:], s.Px[y*s.W:(y+1)*s.W])
		}
	}
	lib.WriteIdx(out, "aiz-sprites.png", atlas, AW, AH)

	// The palettes it went through, and which one each frame showed.
	palKey := func(p []int) string {
		var b strings.Builder
		for _, c := range p {
			fmt.Fprintf(&b, "%03x", c)
		}
		return b.String()
	}
	var pals []string
	palIdx := map[string]int{}
	for _, t := range timeline {
		k := palKey(t.pal)
		if _, ok := palIdx[k]; !ok {
			palIdx[k] = len(pals)
			pals = append(pals, k)
		}
		t.p = palIdx[k]
	}

	// The last frame, composited, is the still.
	composite := func(t *frame) []byte {
		o, e := make([]byte, 320*224), bands(t.bg)
		for i := range o {
			o[i] = 32 // backdrop: VDP $8720, line 2 colour 0
		}
		for y := 0; y < 224; y++ {
			off := e[0]
			if y >= 80 {
				off = e[1+((y-80)>>2)]
			}
			for x := 0; x < 320; x++ {
				X := x + off
				if X < 0 {
					X = ((X % 512) + 512) % 512
				}
				if X < bgX1 {
					if v := bg.lo[y*bgX1+X]; v != 0 {
						o[y*320+x] = v
					}
				}
			}
		}
		W := fgX1 - fgX0
		plane := func(layer []byte) {
			for y := 0; y < 224; y++ {
				for x := 0; x < 320; x++ {
					X := x + t.cam - fgX0
					if X < 0 || X >= W {
						continue
					}
					if v := layer[y*W+X]; v != 0 {
						o[y*320+x] = v
					}
				}
			}
		}
		sprites := func(hi int) {
			for _, ts := range t.spr {
				s := SPRITES[ts[0]]
				if s.Hi != hi {
					continue
				}
				for y := 0; y < s.H; y++ {
					for x := 0; x < s.W; x++ {
						v, X, Y := s.Px[y*s.W+x], ts[1]+s.Ox+x, ts[2]+s.Oy+y
						if v != 0 && X >= 0 && X < 320 && Y >= 0 && Y < 224 {
							o[Y*320+X] = v
						}
					}
				}
			}
		}
		plane(fg.lo)
		sprites(0)
		plane(fg.hi)
		sprites(1)
		return o
	}
	last := timeline[len(timeline)-1]
	lastPal := make([][3]byte, len(last.pal))
	for i, w := range last.pal {
		lastPal[i] = lib.RGB(w)
	}
	still := lib.EncodeIndexedPNG(composite(last), 320, 224, lastPal, -1)
	lib.WriteFile(out, "aiz-still.png", still)
	fmt.Printf("aiz-still.png     320x224  %dB\n", len(still))

	// Per-frame series, run-length coded: [value, count, ...].
	rle := func(get func(*frame) int) []int {
		o := []int{}
		for _, t := range timeline {
			v := get(t)
			if len(o) > 0 && o[len(o)-2] == v {
				o[len(o)-1]++
			} else {
				o = append(o, v, 1)
			}
		}
		return o
	}
	sprites := make([][]int, len(SPRITES))
	for i, s := range SPRITES {
		sprites[i] = []int{s.ax, s.ay, s.W, s.H, s.Ox, s.Oy, s.Hi}
	}
	sprs := make([][]int, len(timeline))
	for i, t := range timeline {
		sprs[i] = []int{}
		for _, s := range t.spr {
			sprs[i] = append(sprs[i], s[:]...)
		}
	}
	meta := lib.O(
		"len", len(timeline), "fgX0", fgX0, "camY", CAM_Y,
		"sprites", sprites,
		"pals", pals, "pal", rle(func(t *frame) int { return t.p }),
		"cam", rle(func(t *frame) int { return t.cam }), "bg", rle(func(t *frame) int { return t.bg }),
		"spr", sprs,
	)
	js := lib.Stringify(meta)
	lib.WriteFile(out, "aiz-meta.json", []byte(js))
	fmt.Printf("aiz-meta.json     %dB  %d palettes\n", len(js), len(pals))
}
