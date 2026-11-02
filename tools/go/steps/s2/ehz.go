package s2

import (
	"fmt"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

type ehzAnimScript struct {
	art    string
	tile   int
	frames [][2]int
	sheet  []byte
}

type animCell struct{ x, y, w, a, X, Y int }

// make_block_tile(tile, xflip, yflip, pal, pri)
func mbt(t, xf, yf, pal, pri int) int { return (pri << 15) | (pal << 13) | (yf << 12) | (xf << 11) | t }

func be16(b []byte, i int) int { return int(b[i])<<8 | int(b[i+1]) }

// dplcFrame loads a frame's art per its DPLC from the uncompressed sheet, and renders it.
func dplcFrame(m []lib.Frame, dplc [][][2]int, sheet []byte, f, line int) *lib.Rendered {
	var tiles [][]byte
	for _, d := range dplc[f] {
		for i := 0; i < d[0]; i++ {
			tiles = append(tiles, subarray(sheet, (d[1]+i)*32, (d[1]+i+1)*32))
		}
	}
	art := make([]byte, len(tiles)*32)
	for i, t := range tiles {
		copy(art[i*32:], t)
	}
	return lib.RenderFrame(m[f], art, lib.RenderOpts{Line: line})
}

// ==== Emerald Hill Zone act 1 ==========================================================================
// The level at its start: Sonic at ($60,$28F), Tails $20 behind and 4 lower, the camera at (0,$22F).
// EHZ_HTZ art (Kosinski) at tile 0; 16x16 blocks of four tile words; 128x128 chunks of 8x8 block words
// (bits 0-9 the block, 10-11 its flips); the layout's rows alternate foreground and background, $80
// bytes each. Pal_EHZ is lines 1-3, over Pal_BGND's line 0.
func buildEHZ(out string, t *title, card *cardResult) {
	cam, ripple := card.cam, t.ripple
	kos := func(f string) []byte { d, _ := lib.KosDecode(rd(f), 0); return d }
	lvArt, lvBlocks, lvChunks, lvLayout := kos("S2_EHZ_Art.kos"), kos("S2_EHZ_Blocks.kos"), kos("S2_EHZ_Chunks.kos"), kos("S2_EHZ1_Layout.kos")
	lvVram := make([]byte, 0x800*32)
	copy(lvVram, lvArt)
	// LoadAnimatedBlocks: APM_EHZ's blocks go in at the end of the table (Block_Table + $1800 - their
	// length), drawn from the tiles Animated_EHZ reloads. make_block_tile(tile, xflip, yflip, pal, pri).
	const MTN, PULSE, CHECK = 0x500, 0x39C, 0x158
	FL := []int{0x394, 0x396, 0x398, 0x39A}
	var APM []int
	for _, q := range [][]int{{0, 4, 1, 5}, {8, 0xC, 9, 0xD}, {0x10, 0x14, 0x11, 0x15}, {2, 6, 3, 7}, {0xA, 0xE, 0xB, 0xF}, {0x12, 0x16, 0x13, 0x17}} {
		for _, o := range q {
			APM = append(APM, mbt(MTN+o, 0, 0, 2, 0))
		}
	}
	for _, q := range [][]int{{0x18, 0x1A, 0x19, 0x1B}, {0x1C, 0x1E, 0x1D, 0x1F}} {
		for _, o := range q {
			APM = append(APM, mbt(MTN+o, 0, 0, 3, 0))
		}
	}
	APM = append(APM,
		mbt(PULSE, 0, 0, 2, 0), mbt(PULSE, 1, 0, 2, 0), mbt(PULSE+1, 0, 0, 2, 0), mbt(PULSE+1, 1, 0, 2, 0),
		mbt(CHECK, 0, 0, 2, 0), mbt(PULSE, 0, 0, 2, 0), mbt(CHECK+1, 0, 0, 2, 0), mbt(PULSE+1, 0, 0, 2, 0),
		mbt(PULSE, 1, 0, 2, 0), mbt(CHECK, 1, 0, 2, 0), mbt(PULSE+1, 1, 0, 2, 0), mbt(CHECK+1, 1, 0, 2, 0))
	for i, t := range FL {
		APM = append(APM, mbt(t, 0, 0, 3, i&1), mbt(t, 1, 0, 3, i&1), mbt(t+1, 0, 0, 3, i&1), mbt(t+1, 1, 0, 3, i&1))
	}
	blockWords := make([]int, 0x300*4)
	for i := range blockWords {
		if i*2 < len(lvBlocks) {
			blockWords[i] = be16(lvBlocks, i*2)
		}
	}
	apmAt := (0x1800 - len(APM)*2) / 2
	if apmAt*2 < len(lvBlocks) {
		panic("the animated blocks would overwrite real ones")
	}
	copy(blockWords[apmAt:], APM)
	// Animated_EHZ: [the art, its VRAM tile, the frames as [tile offset, duration]]. Each script's first
	// frame is loaded by AniArt_Load before the level starts; then Dynamic_Normal steps it once a frame
	// of the main loop -- a frame lasts its duration + 1.
	ANIM := []*ehzAnimScript{
		{art: "S2_EHZ_Flowers1.unc", tile: FL[0], frames: [][2]int{{0, 0x7F}, {2, 0x13}, {0, 7}, {2, 7}, {0, 7}, {2, 7}}},
		{art: "S2_EHZ_Flowers2.unc", tile: FL[1], frames: [][2]int{{2, 0x7F}, {0, 0xB}, {2, 0xB}, {0, 0xB}, {2, 5}, {0, 5}, {2, 5}, {0, 5}}},
		{art: "S2_EHZ_Flowers3.unc", tile: FL[2], frames: [][2]int{{0, 7}, {2, 7}}},
		{art: "S2_EHZ_Flowers4.unc", tile: FL[3], frames: [][2]int{{0, 0x7F}, {2, 7}, {0, 7}, {2, 7}, {0, 7}, {2, 0xB}, {0, 0xB}, {2, 0xB}}},
		{art: "S2_EHZ_PulseBall.unc", tile: PULSE, frames: [][2]int{{0, 0x17}, {2, 9}, {4, 0xB}, {6, 0x17}, {4, 0xB}, {2, 9}}},
	}
	load := func(a *ehzAnimScript, off int) { copy(lvVram[a.tile*32:], subarray(a.sheet, off*32, (off+2)*32)) }
	for _, a := range ANIM {
		a.sheet = rd(a.art)
		load(a, a.frames[0][0])
	}
	animOf := func(t int) int {
		for i, a := range ANIM {
			if t >= a.tile && t < a.tile+2 {
				return i
			}
		}
		return -1
	}
	lvWord := func(x, y int, bg bool) int {
		row := 0
		if bg {
			row = 0x80
		}
		id := int(lvLayout[(y>>7)*0x100+row+(x>>7)])
		cw := be16(lvChunks, id*128+((y>>4)&7)*16+((x>>4)&7)*2)
		b := cw & 0x3FF
		qx, qy := (x>>3)&1, (y>>3)&1
		if cw&0x400 != 0 {
			qx ^= 1
		}
		if cw&0x800 != 0 {
			qy ^= 1
		}
		w := 0 // past the table: 0
		if i := b*4 + qy*2 + qx; i < len(blockWords) {
			w = blockWords[i]
		}
		if cw&0x400 != 0 {
			w ^= 0x800
		}
		if cw&0x800 != 0 {
			w ^= 0x1000
		}
		return w
	}
	lvPixel := func(w, X, Y int) byte {
		t, sx, sy := w&0x7FF, X&7, Y&7
		if w&0x800 != 0 {
			sx = 7 - sx
		}
		if w&0x1000 != 0 {
			sy = 7 - sy
		}
		b := lvVram[t*32+sy*4+(sx>>1)]
		c := b >> 4
		if sx&1 != 0 {
			c = b & 15
		}
		if c == 0 {
			return 0
		}
		return byte(((w>>13)&3)*16) + c
	}
	// plane A: the foreground at the camera, split by priority. Cells drawn from an animated script's
	// tiles are left out and kept, per script and frame, as overlays the page swaps.
	fgLo, fgHi := make([]byte, W*H), make([]byte, W*H)
	var animCells []animCell
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			X, Y := x+cam.x, y+cam.y
			w := lvWord(X, Y, false)
			if a := animOf(w & 0x7FF); a >= 0 {
				animCells = append(animCells, animCell{x, y, w, a, X, Y})
				continue
			}
			if v := lvPixel(w, X, Y); v != 0 {
				if w&0x8000 != 0 {
					fgHi[y*W+x] = v
				} else {
					fgLo[y*W+x] = v
				}
			}
		}
	}
	lib.WriteIdx(out, "ehz-fg.png", fgLo, W, H)
	lib.WriteIdx(out, "ehz-fg-hi.png", fgHi, W, H)
	var ehzAnim []any
	var scripts []int
	for _, c := range animCells {
		scripts = append(scripts, c.a)
	}
	scripts = uniq(scripts)
	for _, ai := range scripts {
		a := ANIM[ai]
		var cells []animCell
		for _, c := range animCells {
			if c.a == ai {
				cells = append(cells, c)
			}
		}
		x0, y0, x1, y1 := 1<<30, 1<<30, -(1 << 30), -(1 << 30)
		for _, c := range cells {
			x0, y0, x1, y1 = min(x0, c.x), min(y0, c.y), max(x1, c.x), max(y1, c.y)
		}
		w, h := x1-x0+1, y1-y0+1
		layers := &lib.Obj{}
		var offs []int
		for _, f := range a.frames {
			offs = append(offs, f[0])
		}
		for _, off := range uniq(offs) {
			load(a, off)
			for hi := 0; hi <= 1; hi++ {
				px := make([]byte, w*h)
				for _, c := range cells {
					if (c.w&0x8000 != 0) == (hi != 0) {
						if v := lvPixel(c.w, c.X, c.Y); v != 0 {
							px[(c.y-y0)*w+c.x-x0] = v
						}
					}
				}
				if !anyNonZero(px) {
					continue
				}
				name := fmt.Sprintf("ehz-anim%d-%d-%d.png", ai, off, hi)
				lib.WriteIdx(out, name, px, w, h)
				layers.Set(fmt.Sprintf("%d-%d", off, hi), name)
			}
		}
		load(a, a.frames[0][0])
		ehzAnim = append(ehzAnim, lib.O("x", x0, "y", y0, "frames", a.frames, "layers", layers))
	}
	fmt.Printf("  EHZ: animated tiles on screen from %d script(s): %v\n", len(ehzAnim), scripts)
	// plane B: DrawInitialBG draws 512px of background from the BG camera, (0,0) here (InitCam_EHZ), and
	// nothing redraws it while the camera stands still.
	ehzBg := make([]byte, bgW*H)
	for y := 0; y < H; y++ {
		for x := 0; x < bgW; x++ {
			w := lvWord(x, y, true)
			if w&0x8000 != 0 {
				panic("a background tile is high priority")
			}
			if animOf(w&0x7FF) >= 0 {
				panic("animated tiles in the background")
			}
			if v := lvPixel(w, x, y); v != 0 {
				ehzBg[y*bgW+x] = v
			}
		}
	}
	lib.WriteIdx(out, "ehz-bg.png", ehzBg, bgW, H)

	// ---- the sprites ----------------------------------------------------------------------------------
	// Sonic and Tails load their art per frame (DPLCs) from their uncompressed sheets; Tails' tails are
	// his own sheet's frames 9-$D. All three on palette line 0, low priority. Rings: ArtNem_Ring on line 1.
	sonicMap, sonicDplc := lib.ParseS1MapFrames(string(rd("S2_Sonic_map.asm"))), lib.ParseMacroDplcFrames(string(rd("S2_Sonic_dplc.asm")))
	tailsMap, tailsDplc := lib.ParseS1MapFrames(string(rd("S2_Tails_map.asm"))), lib.ParseMacroDplcFrames(string(rd("S2_Tails_dplc.asm")))
	sonicSheet, tailsSheet := rd("S2_Sonic.unc"), rd("S2_Tails.unc")
	ehzSprites, ehzSpritePx := &lib.Obj{}, map[string]*lib.Rendered{}
	spr := func(name string, r *lib.Rendered) {
		lib.WriteIdx(out, "ehz-"+name+".png", r.Px, r.W, r.H)
		ehzSprites.Set(name, lib.O("ox", r.Ox, "oy", r.Oy))
		ehzSpritePx[name] = r
	}
	spr("sonic", dplcFrame(sonicMap, sonicDplc, sonicSheet, 1, 0)) // SonAni_Wait's frame for its first 180
	// TailsAni_Wait: duration 7, frames 1 x10, 3, 2 (a blink), 1 ...; Obj05Ani_Swish: duration 7, 9-$D
	TAILS_WAIT := []int{1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 2, 1, 1, 1, 1, 1, 1, 1, 1, 3, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 5}
	for _, f := range uniq(TAILS_WAIT) {
		spr(fmt.Sprintf("tails%d", f), dplcFrame(tailsMap, tailsDplc, tailsSheet, f, 0))
	}
	for _, f := range []int{9, 10, 11, 12, 13} {
		spr(fmt.Sprintf("tail%d", f), dplcFrame(tailsMap, tailsDplc, tailsSheet, f, 0))
	}
	ringArt, ringMap := lib.NemDecode(rd("S2_Ring.nem")), lib.ParseS1MapFrames(string(rd("S2_Ring_map.asm")))
	for _, f := range []int{0, 1, 2, 3} {
		spr(fmt.Sprintf("ring%d", f), lib.RenderFrame(ringMap[f], ringArt, lib.RenderOpts{Line: 1}))
	}
	// Rings_EHZ_1 puts three in a row at ($124,$240), 24 apart: the first two are on screen. BuildRings'
	// +8 and -8 cancel, so each is drawn at its position less the camera's.
	type point struct{ x, y int }
	var rings []point
	var ringsJSON []any
	for _, x := range []int{0x124, 0x13C} {
		p := point{x - cam.x, 0x240 - cam.y}
		rings = append(rings, p)
		ringsJSON = append(ringsJSON, lib.O("x", p.x, "y", p.y))
	}

	// ---- palettes ---------------------------------------------------------------------------------------
	// While the card is up, Pal_BGND is lines 0-1 and lines 2-3 are still black from the fade; the level
	// brings Pal_EHZ's lines 1-3 (line 1 is the card's line 1 again). In the level PalCycle_EHZ steps the
	// water colours -- line 1, colours 3-4 and 14-15 -- every 8 frames through four states.
	lvPal, water := lib.Words(rd("S2_Pal_EHZ.bin")), lib.Words(rd("S2_Pal_EHZWater.bin"))
	if len(lvPal) != 48 || len(water) != 16 {
		panic("unexpected EHZ palette sizes")
	}
	cardPal := card.pal
	ehzPals := []string{phex(append(append([]int{}, cardPal...), make([]int, 32)...))}
	for k := 0; k < 4; k++ {
		p := append(append([]int{}, cardPal[:16]...), lvPal...)
		p[16+3], p[16+4], p[16+14], p[16+15] = water[k*4], water[k*4+1], water[k*4+2], water[k*4+3]
		ehzPals = append(ehzPals, phex(p))
	}
	sonic, tails := point{0x60 - cam.x, 0x28F - cam.y}, point{0x40 - cam.x, 0x293 - cam.y}
	bgOutInit := -1
	for i, e := range card.tl {
		if e.Get("reveal") != nil {
			bgOutInit = i
			break
		}
	}
	ehzMeta := lib.O("pals", ehzPals, "tailsWait", TAILS_WAIT, "anim", ehzAnim, "sprites", ehzSprites, "rings", ringsJSON, "ripple", ripple,
		"sonic", lib.O("x", sonic.x, "y", sonic.y), "tails", lib.O("x", tails.x, "y", tails.y),
		"rippleTop", 80, "rippleLines", 21, "bgOutInit", bgOutInit,
		"objsFrom", card.objsFrom, "mainFrom", card.mainFrom, "cardFrames", len(card.tl))

	// ---- the still: the level standing, frame 0 of its own loop -------------------------------------------
	// The water lines ripple from the start of SwScrl_RippleData; the page takes the frame counter as one
	// short of a step there, so its first step back comes 8 frames on.
	{
		px := make([]byte, W*H)
		for i := range px {
			px[i] = 32
		}
		for y := 0; y < H; y++ {
			s := 0
			if y >= 80 && y < 101 {
				s = ripple[y-80]
			}
			for x := 0; x < W; x++ {
				if v := ehzBg[y*bgW+((x-s)&511)]; v != 0 {
					px[y*W+x] = v
				}
			}
		}
		for i := range px {
			if fgLo[i] != 0 {
				px[i] = fgLo[i]
			}
		}
		for _, c := range animCells {
			if c.w&0x8000 == 0 {
				if v := lvPixel(c.w, c.X, c.Y); v != 0 {
					px[c.y*W+c.x] = v
				}
			}
		}
		put := func(name string, X, Y int) {
			f := ehzSpritePx[name]
			for y := 0; y < f.H; y++ {
				for x := 0; x < f.W; x++ {
					v, sx, sy := f.Px[y*f.W+x], X+f.Ox+x, Y+f.Oy+y
					if v != 0 && sx >= 0 && sx < W && sy >= 0 && sy < H {
						px[sy*W+sx] = v
					}
				}
			}
		}
		// back to front: the rings, Tails' tails, Tails, Sonic (slot order, all priority 2 bar the rings)
		for _, r := range rings {
			put("ring1", r.x, r.y)
		}
		put("tail9", tails.x, tails.y)
		put("tails1", tails.x, tails.y)
		put("sonic", sonic.x, sonic.y)
		for i := range px {
			if fgHi[i] != 0 {
				px[i] = fgHi[i]
			}
		}
		for _, c := range animCells {
			if c.w&0x8000 != 0 {
				if v := lvPixel(c.w, c.X, c.Y); v != 0 {
					px[c.y*W+c.x] = v
				}
			}
		}
		data := lib.EncodeIndexedPNG(px, W, H, hexPalette(ehzPals[1]), -1)
		lib.WriteFile(out, "ehz-still.png", data)
		fmt.Printf("ehz-still.png    320x224  %dB\n", len(data))
	}
	lib.WriteFile(out, "ehz-meta.json", []byte(lib.Stringify(ehzMeta)))
}
