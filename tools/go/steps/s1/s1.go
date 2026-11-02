/*
Package s1 builds the Sonic 1 assets: the title screen, the credits lettering,
the title card, Green Hill Zone, and the logo faces.

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
derived in credits.go.
*/
package s1

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

const W, H = 320, 224

// the GHZ plane B and the emblem, which the later scenes reuse
type title struct {
	tiles, chunks, bg, emblem []byte
	blocks                    []int
}

const (
	BG_Y, BG_W = 8, 512
	EW, EH     = 34, 22
	EX, EY     = 3 * 8, 4 * 8
)

// Build writes every Sonic 1 file into out.
func Build(out string) {
	out = lib.OutDir(out)
	t := buildTitle(out)
	buildCredits(out)
	buildCard(out)
	buildGHZ(out, t)
	buildLogo(out, t.emblem)
}

// at reads a byte, 0 past either end.
func at(b []byte, i int) int {
	if i < 0 || i >= len(b) {
		return 0
	}
	return int(b[i])
}

func atw(w []int, i int) int {
	if i < 0 || i >= len(w) {
		return 0
	}
	return w[i]
}

// put stores as a Uint8Array does: a store out of range is dropped.
func put(px []byte, i int, v byte) {
	if i >= 0 && i < len(px) {
		px[i] = v
	}
}

// u16 is Buffer.readUInt16BE, which throws out of range as this panics.
func u16(b []byte, i int) int { return int(b[i])<<8 | int(b[i+1]) }

func hex(p []int) string {
	var b strings.Builder
	for _, c := range p {
		fmt.Fprintf(&b, "%03x", c)
	}
	return b.String()
}

func hexToPal(h string) [][3]byte {
	pal := make([][3]byte, 64)
	for i := range pal {
		v, err := strconv.ParseInt(h[min(i*3, len(h)):min(i*3+3, len(h))], 16, 64)
		if err != nil {
			v = 0 // parseInt's NaN, which rgb's bit maths read as 0
		}
		pal[i] = lib.RGB(int(v))
	}
	return pal
}

func buildTitle(out string) title {
	// ---- plane B: the GHZ background ---------------------------------------------------
	// Blk16_GHZ (Enigma) blocks of four nametable words; Blk256_GHZ (Kosinski) chunks of
	// 16x16 block words, whose bits 13-14 are solidity and masked off for drawing; the BG
	// layout is width-1, height-1, then chunk IDs, 0 empty and 1-based.
	tiles := lib.NemDecode(lib.Rom("S1_GHZ1.nem")) // Nem_GHZ_1st only
	blocks := lib.EniDecode(lib.Rom("S1_GHZ_Blocks.eni"), 0)
	chunks, _ := lib.KosDecode(lib.Rom("S1_GHZ_Chunks.kos"), 0)
	lay := lib.Rom("S1_GHZ_BG.bin")
	layW, layH := int(lay[0])+1, int(lay[1])+1
	bgWord := func(x, y int) int {
		row, col := y>>8, (x>>8)%layW
		if row >= layH {
			return 0
		}
		id := at(lay, 2+row*layW+col) & 0x7F
		if id == 0 {
			return 0
		}
		cw := u16(chunks, (id-1)*0x200+((y>>4)&15)*32+((x>>4)&15)*2)
		b := cw & 0x3FF
		qx, qy := (x>>3)&1, (y>>3)&1
		if cw&0x800 != 0 {
			qx ^= 1
		}
		if cw&0x1000 != 0 {
			qy ^= 1
		}
		w := atw(blocks, b*4+qy*2+qx)
		if cw&0x800 != 0 {
			w ^= 0x800
		}
		if cw&0x1000 != 0 {
			w ^= 0x1000
		}
		return w
	}
	// GM_Title's DrawChunks fills the 512px plane once from BG x 0; afterwards only
	// the hills strip is redrawn, a column at a time, and only once the camera has
	// carried bg2x+320 past 512 does that column differ from the first draw. The
	// page's timeline stops well short of it (asserted below), so one 512px strip,
	// wrapped, is the plane exactly.
	bg := make([]byte, BG_W*H)
	for y := 0; y < H; y++ {
		for x := 0; x < BG_W; x++ {
			Y := y + BG_Y
			w := bgWord(x, Y)
			t := w & 0x7FF
			if w&0x8000 != 0 {
				panic("a background tile is high priority")
			}
			sx, sy := x&7, Y&7
			if w&0x800 != 0 {
				sx = 7 - (x & 7)
			}
			if w&0x1000 != 0 {
				sy = 7 - (Y & 7)
			}
			if c := nibble(at(tiles, t*32+sy*4+(sx>>1)), sx); c != 0 {
				bg[y*BG_W+x] = byte(((w>>13)&3)*16 + c)
			}
		}
	}
	lib.WriteIdx(out, "s1-bg.png", bg, BG_W, H)

	// ---- plane A: the emblem -------------------------------------------------------------
	// Eni_Title's words already carry the emblem's $200 tile base (tile 0 is blank VRAM),
	// all palette line 0, priority 0, X-flip the only flag. Copied to vram_fg+$206:
	// cell (3,4), so the emblem sits 8px left of centre, as it does in the game.
	fg := lib.NemDecode(lib.Rom("S1_TitleFg.nem"))
	emb := lib.EniDecode(lib.Rom("S1_Title.eni"), 0)
	if len(emb) != EW*EH {
		panic(fmt.Sprintf("emblem map is %d words", len(emb)))
	}
	emblem := make([]byte, EW*8*EH*8)
	for i, w := range emb {
		t := w & 0x7FF
		if t == 0 {
			continue
		}
		if w&0x9000 != 0 {
			panic("emblem tile has priority or Y-flip")
		}
		cx, cy, a := (i%EW)*8, (i/EW)*8, (t-0x200)*32
		for y := 0; y < 8; y++ {
			for x := 0; x < 8; x++ {
				sx := x
				if w&0x800 != 0 {
					sx = 7 - x
				}
				if c := nibble(at(fg, a+y*4+(sx>>1)), sx); c != 0 {
					emblem[(cy+y)*EW*8+cx+x] = byte(((w>>13)&3)*16 + c)
				}
			}
		}
	}
	lib.WriteIdx(out, "s1-emblem.png", emblem, EW*8, EH*8)

	// ---- sprites ---------------------------------------------------------------------------
	// TitleSonic: Nem_TitleSonic at $300 on palette line 1, eight frames, all pieces at
	// positive offsets from its origin, screen x $70. The TM: Nem_TitleTM at $510, line 1.
	var sonic []*lib.Obj
	meta := lib.O("sonic", nil, "tm", nil)
	sonicArt := lib.NemDecode(lib.Rom("S1_TitleSonic.nem"))
	for i, f := range lib.ParseS1MapFrames(string(lib.Rom("S1_TitleSonic_map.asm"))) {
		r := lib.RenderFrame(f, sonicArt, lib.RenderOpts{Line: 1})
		lib.WriteIdx(out, fmt.Sprintf("s1-sonic%d.png", i), r.Px, r.W, r.H)
		sonic = append(sonic, lib.O("ox", r.Ox, "oy", r.Oy, "w", r.W, "h", r.H))
	}
	meta.Set("sonic", sonic)
	tmArt := lib.NemDecode(lib.Rom("S1_TitleTM.nem"))
	tmFrame := lib.ParseS1MapFrames(string(lib.Rom("S1_PressStartTM_map.asm")))[3] // frame 3: TM
	tm := lib.RenderFrame(tmFrame, tmArt, lib.RenderOpts{Line: 1})
	lib.WriteIdx(out, "s1-tm.png", tm.Px, tm.W, tm.H)
	tmX, tmY := 0xF0+tm.Ox, 0x78+tm.Oy // obX $80+$F0, obScreenY $80+$78
	meta.Set("tm", lib.O("x", tmX, "y", tmY))

	// ---- palettes ----------------------------------------------------------------------------
	// palid_Title, faded in by PaletteFadeIn: 22 steps, each colour +$200 (blue) if it fits,
	// else +$20, else +2, whole-word compares, from black. Then PalCycle_Title rotates line 2
	// colours 8-11 through Cycle - Title Screen Water every 6 frames: four states.
	target := lib.Words(lib.Rom("S1_Pal_Title.bin"))
	water := lib.Words(lib.Rom("S1_Pal_TitleWater.bin"))
	if len(target) != 64 || len(water) != 16 {
		panic("unexpected S1 palette sizes")
	}
	var pals []string
	cur := make([]int, 64)
	for s := 0; s < 22; s++ {
		pals = append(pals, hex(cur)) // display frame s shows step s
		next := make([]int, 64)
		for i, c := range cur {
			next[i] = fadeStep(c, target[i])
		}
		cur = next
	}
	if hex(cur) != hex(target) {
		panic("the fade does not land on the title palette")
	}
	for k := 0; k < 4; k++ {
		p := append([]int(nil), target...)
		for i := 0; i < 4; i++ {
			p[32+8+i] = water[k*4+i]
		}
		pals = append(pals, hex(p))
	}
	meta.Set("pals", pals)
	meta.Set("fadeFrames", 22)

	// ---- the timeline's constants ----------------------------------------------------------
	// Main-loop iteration T shows on display frame 22+T (frame 22 is the pre-loop state).
	// TitleSonic: hidden until T=29, at screen y 94 rising 8/frame to 22 by T=38; frame 0
	// until T=46, appear frames 1-5 at 8 each, then 6/7 every 8 from T=86 (Ani_TSon). The
	// camera follows an empty object moving 2px/frame: camX = 2(T-41) from T=42. Deform_GHZ:
	// bg2x = camX/2, bg3x = 3/8 camX, three cloud bands auto-scrolling by deform call n=T+2.
	// The 30-sprite line-limit mask hides Sonic on lines 104-199.
	const (
		sonicX, sonicY, sonicTop      = 0x70, 0x5E, 0x16
		appear, frame1, wag, camStart = 29, 46, 86, 41
		maskTop, maskBottom           = 104, 200
	)
	meta.Set("sonicX", sonicX).Set("sonicY", sonicY).Set("sonicTop", sonicTop)
	meta.Set("appear", appear).Set("frame1", frame1).Set("wag", wag).Set("camStart", camStart)
	meta.Set("maskTop", maskTop).Set("maskBottom", maskBottom).Set("emblem", lib.O("x", EX, "y", EY))
	meta.Set("intro", 22+wag) // the text springs in as he starts to wag
	const LAST_T = wag + 120  // spring plus slack
	if (LAST_T-camStart)+320 >= BG_W {
		panic("the timeline runs into the plane-B column redraws; emulate the plane")
	}

	// ---- the still: settled, mid-wag ----------------------------------------------------------
	{
		T := wag
		still := filled(W*H, 32) // backdrop: line 2 colour 0
		camX := max(0, 2*(T-camStart))
		bg2 := camX / 2 // camX is even, so this is exact
		bg3 := int(math.Floor(0.75 * float64(max(0, T-camStart))))
		n := T + 2
		cU, cM, cL := n, int(math.Floor(0.75*float64(n))), n>>1
		q := (bg2 << 8) / 0x68
		step := q << 8
		for y := 0; y < H; y++ {
			var s int
			switch {
			case y < 24:
				s = cU + bg3
			case y < 40:
				s = cM + bg3
			case y < 56:
				s = cL + bg3
			case y < 104:
				s = bg3
			case y < 144:
				s = bg2
			default:
				s = int(int32((bg2<<16)+(y-144)*step) >> 16)
			}
			for x := 0; x < W; x++ {
				if v := bg[y*BG_W+((x+s)&511)]; v != 0 {
					still[y*W+x] = v
				}
			}
		}
		for y := 0; y < EH*8; y++ {
			for x := 0; x < EW*8; x++ {
				if v := emblem[y*EW*8+x]; v != 0 {
					put(still, (EY+y)*W+EX+x, v)
				}
			}
		}
		f := lib.ParseS1MapFrames(string(lib.Rom("S1_TitleSonic_map.asm")))[6]
		r := lib.RenderFrame(f, sonicArt, lib.RenderOpts{Line: 1})
		for y := 0; y < r.H; y++ {
			for x := 0; x < r.W; x++ {
				v, X, Y := r.Px[y*r.W+x], sonicX+r.Ox+x, sonicTop+r.Oy+y
				if v != 0 && Y < maskTop {
					put(still, Y*W+X, v)
				}
			}
		}
		tm := lib.RenderFrame(tmFrame, lib.NemDecode(lib.Rom("S1_TitleTM.nem")), lib.RenderOpts{Line: 1})
		for y := 0; y < tm.H; y++ {
			for x := 0; x < tm.W; x++ {
				if v := tm.Px[y*tm.W+x]; v != 0 {
					put(still, (tmY+y)*W+tmX+x, v)
				}
			}
		}
		// the water colours PalCycle_Title has reached by then: a step every 6 frames from T=1
		pal := hexToPal(pals[22+(((T-1)/6)&3)])
		data := lib.EncodeIndexedPNG(still, W, H, pal, -1)
		lib.WriteFile(out, "s1-still.png", data)
		fmt.Printf("s1-still.png     320x224  %dB\n", len(data))
	}
	lib.WriteFile(out, "s1-meta.json", []byte(lib.Stringify(meta)))
	return title{tiles: tiles, chunks: chunks, bg: bg, emblem: emblem, blocks: blocks}
}

// nibble is a 4bpp tile byte's pixel: the high nibble for even x, the low for odd.
func nibble(b, sx int) int {
	if sx&1 != 0 {
		return b & 15
	}
	return b >> 4
}

// fadeStep is one PaletteFadeIn step of colour c towards t.
func fadeStep(c, t int) int {
	switch {
	case c == t:
		return c
	case c+0x200 <= t:
		return c + 0x200
	case c+0x20 <= t:
		return c + 0x20
	}
	return c + 2
}

func filled(n int, v byte) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = v
	}
	return b
}
