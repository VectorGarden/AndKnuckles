/*
Package sk builds every S&K title asset the page embeds, from the disassembly's
own data: the Go port of tools/build-sk-assets.mjs. Nothing here ships in
index.html except the finished PNGs, which are pasted in as base64 -- see
tools/README.md.

Four stages that used to be separate throwaway scripts, folded together so
there are no intermediate files to keep in sync:
 1. Kosinski / moduled Kosinski for the tile art
 2. the runtime hand DMAs patched over the standing art
 3. Enigma for the plane tilemaps
 4. compose the layers, crop, and write indexed PNGs + intro-meta.json
*/
package sk

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

const (
	W     = 320
	H     = 224
	EMPTY = 0xFF
)

func newBuf() []byte { b := make([]byte, W*H); fill(b, EMPTY); return b }

func fill(b []byte, v byte) {
	for i := range b {
		b[i] = v
	}
}

// at reads a byte as a typed array does: past the end is undefined, which every
// bit operation here turns into 0.
func at(b []byte, i int) int {
	if i < 0 || i >= len(b) {
		return 0
	}
	return int(b[i])
}

// sub is subarray: the end is clamped to the buffer.
func sub(b []byte, from, to int) []byte { return b[min(from, len(b)):min(to, len(b))] }

type rect struct{ x, y, w, h int }

func (r rect) obj() *lib.Obj { return lib.O("x", r.x, "y", r.y, "w", r.w, "h", r.h) }

func bbox(px []byte) *rect {
	x0, y0, x1, y1 := W, H, -1, -1
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			if px[y*W+x] != EMPTY {
				x0, x1, y0, y1 = min(x0, x), max(x1, x), min(y0, y), max(y1, y)
			}
		}
	}
	if x1 < 0 {
		return nil
	}
	return &rect{x0, y0, x1 - x0 + 1, y1 - y0 + 1}
}

// hand is one Obj_SKTitle_HandAnim channel.
type hand struct {
	name       string
	base, tile int
	words, dur int
	seq        []int
	hold       bool
	states     []int
	idle       int
}

func Build(out string) {
	out = lib.OutDir(out)

	// ---- 1. tile art -----------------------------------------------------------
	kos := func(f string) []byte { d, _ := lib.KosDecode(lib.Rom(f), 0); return d }
	bgArt := kos("SK_BG.kos")
	skArt := lib.KosMDecode(lib.Rom("SK_SonicKnux.kosm"))
	landArt := lib.KosMDecode(lib.Rom("SK_SonicLand.kosm"))
	hands := kos("SK_Hands.kos")
	deArt := kos("SK_DeathEgg.kos")
	mtArt := kos("SK_Mountain.kos")
	fallArt := kos("SK_SonicFall.kos")
	for _, a := range []struct {
		name string
		art  []byte
	}{{"background", bgArt}, {"sonic+knux", skArt}, {"landing", landArt},
		{"hands", hands}, {"death egg", deArt}, {"mountain", mtArt}, {"fall", fallArt}} {
		if len(a.art)%32 != 0 {
			panic(fmt.Sprintf("%s: not tile-aligned (%d bytes)", a.name, len(a.art)))
		}
	}

	// ---- 2. Knuckles' face and fists are placeholders in the blob ---------------
	// Obj_SKTitle_HandAnim DMAs over them at runtime; without replaying those four
	// writes you get leftover garbage across his chest.
	for _, d := range [][3]int{{0x4800, 1, 0x30}, {0x4E40, 4, 0x290}, {0x5880, 0x2D, 0x2F0}, {0x6A20, 0x5C, 0x140}} {
		ram, tile, words := d[0], d[1], d[2]
		copy(skArt[tile*32:], sub(hands, ram-0x4800, ram-0x4800+words*2))
	}

	// ---- 3. plane tilemaps -----------------------------------------------------
	SK := 0xE2
	LAND := SK + len(skArt)/32
	bgmap := lib.EniDecode(lib.Rom("SK_BG.eni"), 0x0000)
	var fmaps [4][]int
	for i := range fmaps {
		fmaps[i] = lib.EniDecode(lib.Rom(fmt.Sprintf("SK_Frame%d.eni", i+1)), 0x8000|SK)
	}
	if len(bgmap) != 40*28 {
		panic(fmt.Sprintf("bg map is %d words, expected 1120", len(bgmap)))
	}

	tileByte := func(t, y, x int) int {
		switch {
		case t < SK:
			return at(bgArt, t*32+y*4+x>>1)
		case t < LAND:
			return at(skArt, (t-SK)*32+y*4+x>>1)
		default:
			return at(landArt, (t-LAND)*32+y*4+x>>1)
		}
	}
	praw := slices.Concat(lib.Rom("SK_Sonic.bin"), lib.Rom("SK_Knux.bin"), lib.Rom("SK_SegaBG.bin")[32:96])
	PAL := make([][3]byte, 64)
	for i := range PAL {
		PAL[i] = lib.RGB(at(praw, i*2)<<8 | at(praw, i*2+1))
	}
	parseMap := func(f string) lib.Frame { return lib.Flatten(lib.ParseMapFrames(string(lib.Rom(f)))) }
	deMap, mtMap, fallMap := parseMap("SK_DeathEgg_map.asm"), parseMap("SK_Mountain_map.asm"), parseMap("SK_SonicFall_map.asm")

	// ---- 4. compose ------------------------------------------------------------
	plane := func(px []byte, m []int, opaque bool) {
		for r := 0; r < 28; r++ {
			for c := 0; c < 40; c++ {
				w := m[r*40+c]
				t, hf, vf, line := w&0x7FF, (w>>11)&1, (w>>12)&1, (w>>13)&3
				for y := 0; y < 8; y++ {
					for x := 0; x < 8; x++ {
						sx, sy := x, y
						if hf != 0 {
							sx = 7 - x
						}
						if vf != 0 {
							sy = 7 - y
						}
						b := tileByte(t, sy, sx)
						idx := b >> 4
						if sx&1 != 0 {
							idx = b & 0x0F
						}
						if idx == 0 && !opaque {
							continue
						}
						px[(r*8+y)*W+c*8+x] = byte(line*16 + idx)
					}
				}
			}
		}
	}
	sprite := func(px []byte, m lib.Frame, art []byte, objX, objY, line int) {
		lib.DrawSprite(px, W, H, m, art, objX, objY, line, false)
	}
	writeLayer := func(px []byte, file string, crop bool) rect {
		r := &rect{0, 0, W, H}
		if crop {
			r = bbox(px)
		}
		if r == nil {
			panic(file + ": empty")
		}
		o := make([]byte, r.w*r.h)
		var used [256]bool
		for y := 0; y < r.h; y++ {
			for x := 0; x < r.w; x++ {
				v := px[(r.y+y)*W+r.x+x]
				o[y*r.w+x] = v
				if v != EMPTY {
					used[v] = true
				}
			}
		}
		var entries []int
		for v, u := range used {
			if u {
				entries = append(entries, v)
			}
		}
		transparent := crop || len(entries) < 64
		first := 0
		var pal [][3]byte
		if transparent {
			first = 1
			pal = append(pal, [3]byte{0, 0, 0})
		}
		var m [256]byte
		for i, v := range entries {
			m[v] = byte(i + first)
			pal = append(pal, PAL[v])
		}
		idx := make([]byte, len(o))
		for i, v := range o {
			if v != EMPTY {
				idx[i] = m[v]
			}
		}
		tr := -1
		if transparent {
			tr = 0
		}
		data := lib.EncodeIndexedPNG(idx, r.w, r.h, pal, tr)
		lib.WriteFile(out, file, data)
		fmt.Printf("%-18s %3dx%3d @%d,%d  %6dB  %d col\n", file, r.w, r.h, r.x, r.y, len(data), len(entries))
		return *r
	}
	// --- ROM constants (Obj_SKTitle_*) ---
	const EGG_X, EGG_Y0, EGG_Y1 = 0x140, 0xB0, 0xF0 // descends 176 -> 240
	const MTN_X, MTN_Y = 0x140, 0x1A8 - 0x100       // $1A8 - camera; already screen-space, so no sprite() bias
	const FALL_X, FALL_Y1 = 0xE8, 0xF0
	// The egg lands at $F0, then Obj_SKTitle_DeathEggShake walks it up 0.5/frame
	// while the camera finishes its own 128px -- settling at $F0-128 = $70, which
	// is exactly the "proper position" the fast-forward path writes.
	const EGG_SETTLED = 0x70
	_ = EGG_Y0

	meta := lib.O()
	px := newBuf()
	plane(px, bgmap, true)
	meta.Set("back", writeLayer(px, "sk-back.png", false).obj())
	var front []*lib.Obj
	for i := 0; i < 4; i++ { // character planes only -- during the
		px = newBuf()              // descent the ROM shows the SEGA logo
		plane(px, fmaps[i], false) // here, and these scroll in after landing
		front = append(front, writeLayer(px, fmt.Sprintf("sk-front%d.png", i+1), false).obj())
	}
	meta.Set("front", front)
	px = newBuf()
	sprite(px, mtMap, mtArt, MTN_X, MTN_Y, 3)                      // "top of the mountain is a sprite so it
	meta.Set("mountain", writeLayer(px, "sk-mtn.png", true).obj()) //  can cover the Death Egg" -- drawn over it
	px = newBuf()
	sprite(px, deMap, deArt, EGG_X, EGG_Y1, 2)
	meta.Set("egg", writeLayer(px, "sk-egg.png", true).obj().Set("anchorY", EGG_Y1))
	px = newBuf()
	sprite(px, fallMap, fallArt, FALL_X, FALL_Y1, 0)
	meta.Set("sonic", writeLayer(px, "sk-fall.png", true).obj().Set("anchorY", FALL_Y1))
	// still = the state the intro ends in: egg landed at $F0, final character frame
	px = newBuf()
	plane(px, bgmap, true)
	sprite(px, deMap, deArt, EGG_X, EGG_SETTLED, 2)
	sprite(px, mtMap, mtArt, MTN_X, MTN_Y, 3)
	plane(px, fmaps[3], false)
	meta.Set("still", writeLayer(px, "sk-still.png", false).obj())
	meta.Set("eggSettled", EGG_SETTLED)
	meta.Set("cam1", 0x100)
	// geometry check: is the egg's base covered by the mountain sprite?
	eggPx := newBuf()
	sprite(eggPx, deMap, deArt, EGG_X, EGG_Y1, 2)
	mtPx := newBuf()
	sprite(mtPx, mtMap, mtArt, MTN_X, MTN_Y, 3)
	eb, mb := bbox(eggPx), bbox(mtPx)
	covered, exposedBelowMtnTop := 0, 0
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			if eggPx[y*W+x] == EMPTY {
				continue
			}
			if mtPx[y*W+x] != EMPTY {
				covered++
			} else if mb != nil && y >= mb.y {
				exposedBelowMtnTop++
			}
		}
	}
	fmt.Printf("\negg bbox    %+v\n", eb)
	fmt.Printf("mountain    %+v\n", mb)
	fmt.Println("egg px hidden by mountain sprite:", covered)
	fmt.Println("egg px below mountain top yet visible:", exposedBelowMtnTop)

	// ---- idle hand animation (Obj_SKTitle_HandAnim) ----------------------------
	// Four channels, each DMAing a run of tiles over the standing art. Every one has
	// exactly three states a block apart, and one of them is what the scene already
	// ships, so only the other two need to exist as overlays.
	HAND := []*hand{
		{name: "smile", base: 0x4800, tile: 0x01, words: 0x30, dur: 5, seq: []int{0, 1, 2}, hold: true, states: []int{0, 3, 6}, idle: 0},
		{name: "finger", base: 0x4920, tile: 0x04, words: 0x290, dur: 3, states: []int{0, 41, 82}, idle: 1},
		{name: "knuck1", base: 0x5880, tile: 0x2D, words: 0x2F0, dur: 3, states: []int{0, 47, 94}, idle: 0},
		{name: "knuck2", base: 0x6A20, tile: 0x5C, words: 0x140, dur: 3, states: []int{0, 20, 40}, idle: 0},
	}
	// sequences straight out of the ROM tables, mapped onto state indices
	RAWSEQ := map[string][]int{
		"finger": {41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
			0, 0, 41, 82, 41, 0, 41, 82, 41, 0, 41, 82, 41},
		"knuck1": {0, 0, 0, 0, 0, 0, 0, 0, 47, 94, 47, 0, 47, 94, 47},
		"knuck2": {0, 0, 20, 40, 20, 0, 0},
	}
	for _, h := range HAND {
		if raw, ok := RAWSEQ[h.name]; ok {
			h.seq = nil
			for _, v := range raw {
				h.seq = append(h.seq, slices.Index(h.states, v))
			}
		}
		if slices.Contains(h.seq, -1) {
			panic(h.name + ": unmapped frame value")
		}
	}
	basePx := newBuf()
	plane(basePx, fmaps[3], false)
	var handsMeta []*lib.Obj
	for _, h := range HAND {
		var patches []any
		o := lib.O("name", h.name, "dur", h.dur, "seq", h.seq, "idle", h.idle, "hold", h.hold)
		for si := range h.states {
			if si == h.idle {
				patches = append(patches, nil)
				continue
			}
			save := slices.Clone(skArt[h.tile*32 : h.tile*32+h.words*2])
			off := h.base - 0x4800 + h.states[si]*32
			copy(skArt[h.tile*32:], sub(hands, off, off+h.words*2))
			px := newBuf()
			plane(px, fmaps[3], false)
			// keep only what this state actually changes
			diff := newBuf()
			n := 0
			for i := range px {
				if px[i] != basePx[i] {
					diff[i] = px[i]
					n++
				}
			}
			copy(skArt[h.tile*32:], save) // restore before the next state
			file := fmt.Sprintf("sk-%s%d.png", h.name, si)
			r := writeLayer(diff, file, true)
			patches = append(patches, lib.O("file", file, "x", r.x, "y", r.y, "w", r.w, "h", r.h, "px", n))
		}
		o.Set("patches", patches)
		if h.name == "smile" {
			o.Set("delay", 3*60) // move.b #3*60,$30(a0)
		}
		period := "one-shot"
		if !h.hold {
			period = fmt.Sprint(h.dur * len(h.seq))
		}
		fmt.Printf("  %-7s %d steps x %df = %s\n", h.name, len(h.seq), h.dur, period)
		handsMeta = append(handsMeta, o)
	}
	meta.Set("hands", handsMeta)

	lib.WriteFile(out, "intro-meta.json", []byte(lib.StringifyIndent(meta, " ")))
	total, count := 0, 0
	for _, e := range lib.Must(os.ReadDir(out)) {
		if strings.HasSuffix(e.Name(), ".png") {
			st := lib.Must(os.Stat(filepath.Join(out, e.Name())))
			total += int(st.Size())
			count++
		}
	}
	fmt.Printf("\n%d assets, %d bytes total\n", count, total)
}
