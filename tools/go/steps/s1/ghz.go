package s1

import (
	"fmt"
	"math"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// ---- Green Hill Zone, act 1, as it opens ---------------------------------------------------
// Where the Sonic 1 title card lands: GHZ1 at its start position. LevelSizeLoad puts the
// camera at (0, $300) for Sonic's start at ($50, $3B0); the only object in that first screen
// is Sonic -- the nearest rings start at x $144, just off the right edge. Plane B is the same
// GHZ background the title draws (BG V-scroll comes out 8 here too), so s1-bg.png serves.
func buildGHZ(out string, t title) {
	tiles2 := make([]byte, (0x1CD+369)*32)
	ghz2 := lib.NemDecode(lib.Rom("S1_GHZ2.nem"))
	if len(t.tiles) > len(tiles2) || 0x1CD*32+len(ghz2) > len(tiles2) {
		panic("RangeError: offset is out of bounds") // as Uint8Array.set throws
	}
	copy(tiles2, t.tiles)
	copy(tiles2[0x1CD*32:], ghz2) // Nem_GHZ_2nd at $1CD
	fgLay := lib.Rom("S1_GHZ1_FG.bin")
	fw, fh := int(fgLay[0])+1, int(fgLay[1])+1
	const CAM_X, CAM_Y = 0, 0x300
	lo, hi := make([]byte, W*H), make([]byte, W*H)
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			X, Y := x+CAM_X, y+CAM_Y
			row, col := Y>>8, X>>8
			if row >= fh || col >= fw {
				continue
			}
			id := at(fgLay, 2+row*fw+col) & 0x7F
			if id == 0 {
				continue
			}
			cw := u16(t.chunks, (id-1)*0x200+((Y>>4)&15)*32+((X>>4)&15)*2)
			qx, qy := (X>>3)&1, (Y>>3)&1
			if cw&0x800 != 0 {
				qx ^= 1
			}
			if cw&0x1000 != 0 {
				qy ^= 1
			}
			w := atw(t.blocks, (cw&0x3FF)*4+qy*2+qx)
			if cw&0x800 != 0 {
				w ^= 0x800
			}
			if cw&0x1000 != 0 {
				w ^= 0x1000
			}
			tile, sx, sy := w&0x7FF, X&7, Y&7
			if w&0x800 != 0 {
				sx = 7 - (X & 7)
			}
			if w&0x1000 != 0 {
				sy = 7 - (Y & 7)
			}
			if c := nibble(at(tiles2, tile*32+sy*4+(sx>>1)), sx); c != 0 {
				layer := lo
				if w&0x8000 != 0 {
					layer = hi
				}
				layer[y*W+x] = byte(((w>>13)&3)*16 + c)
			}
		}
	}
	lib.WriteIdx(out, "ghz-fg.png", lo, W, H)
	lib.WriteIdx(out, "ghz-fg-hi.png", hi, W, H)
	// Sonic standing: MS_Stand, whose DPLC loads Sonic.unc tiles 0-16 in order, so the
	// mapping's tiles index the art directly. Palette line 0. SonAni_Wait holds this frame
	// for 288 frames, longer than anything here runs.
	stand := lib.ParseS1MapFrames(string(lib.Rom("S1_Sonic_map.asm")))[1]
	r := lib.RenderFrame(stand, lib.Rom("S1_Sonic.unc"), lib.RenderOpts{})
	lib.WriteIdx(out, "ghz-sonic.png", r.Px, r.W, r.H)
	// Palette: Sonic's line 0, Pal_GHZ in lines 1-3. Lines 1-3 fade in by PalFadeIn_Alt --
	// the same step as the title's, but line 0 stays lit -- then PalCycle_GHZ rotates line 2
	// colours 8-11 every 6 frames.
	sonic, ghz := lib.Words(lib.Rom("S1_Pal_Sonic.bin"))[:16], lib.Words(lib.Rom("S1_Pal_GHZ.bin"))
	cyc := lib.Words(lib.Rom("S1_Pal_GHZCycle.bin"))
	if len(ghz) != 48 || len(cyc) != 16 {
		panic("unexpected GHZ palette sizes")
	}
	full := append(append([]int(nil), sonic...), ghz...)
	var gp []string
	c := append(append([]int(nil), sonic...), make([]int, 48)...)
	for s := 0; s < 22; s++ {
		gp = append(gp, hex(c))
		next := make([]int, len(c))
		for i, v := range c {
			next[i] = v
			if i >= 16 {
				next[i] = fadeStep(v, full[i])
			}
		}
		c = next
	}
	if hex(c) != hex(full) {
		panic("the GHZ fade does not land on its palette")
	}
	for k := 0; k < 4; k++ {
		p := append([]int(nil), full...)
		for i := 0; i < 4; i++ {
			p[32+8+i] = cyc[k*4+i]
		}
		gp = append(gp, hex(p))
	}
	sonicX, sonicY := 0x50-CAM_X+r.Ox, 0x3B0-CAM_Y+r.Oy
	gmeta := lib.O("pals", gp, "fadeFrames", 22, "sonic", lib.O("x", sonicX, "y", sonicY),
		// after the act lands: the level loads, 4 frames pass, then the 22-frame fade
		"levelDelay", 4)
	// the still: faded in, the first cycle step, Sonic standing
	still := filled(W*H, 32)
	for y := 0; y < H; y++ {
		n, s := 2, 0
		switch {
		case y < 24:
			s = n
		case y < 40:
			s = int(math.Floor(0.75 * float64(n)))
		case y < 56:
			s = n >> 1
		}
		for x := 0; x < W; x++ {
			if v := t.bg[y*BG_W+((x+s)&511)]; v != 0 {
				still[y*W+x] = v
			}
		}
	}
	for i := 0; i < W*H; i++ {
		if lo[i] != 0 {
			still[i] = lo[i]
		}
	}
	for y := 0; y < r.H; y++ {
		for x := 0; x < r.W; x++ {
			if v := r.Px[y*r.W+x]; v != 0 {
				put(still, (sonicY+y)*W+sonicX+x, v)
			}
		}
	}
	for i := 0; i < W*H; i++ {
		if hi[i] != 0 {
			still[i] = hi[i]
		}
	}
	data := lib.EncodeIndexedPNG(still, W, H, hexToPal(gp[22]), -1)
	lib.WriteFile(out, "ghz-still.png", data)
	lib.WriteFile(out, "ghz-meta.json", []byte(lib.Stringify(gmeta)))
	fmt.Printf("ghz-still.png    320x224  %dB\n", len(data))
}
