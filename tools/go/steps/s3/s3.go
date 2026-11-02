/*
Package s3 builds the S3 title screen the page embeds: the settled background,
the opening that leads up to it, and the sprites that animate on top of it --
plus the banner tile sheet the digits were drawn against.

Two planes rather than the S&K screen's layer stack: plane B is the sky and
scenery, plane A is Sonic and the foreground on top of it. The banner is a
sprite in the original, not part of either plane -- which is exactly the gap
the generated text drops into.
*/
package s3

import (
	"fmt"
	"slices"
	"strings"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

const (
	W, H, COLS, ROWS = 320, 224, 40, 28
	EMPTY            = 0xFF
)

// at reads a byte, 0 past the end.
func at(b []byte, i int) int {
	if i < 0 || i >= len(b) {
		return 0
	}
	return int(b[i])
}

// colour is a Genesis word: 0000 BBB0 GGG0 RRR0
func colour(raw []byte, i int) [3]byte { return lib.RGB(at(raw, i*2)<<8 | at(raw, i*2+1)) }

func palOf(raw []byte) [][3]byte {
	p := make([][3]byte, len(raw)/2)
	for i := range p {
		p[i] = colour(raw, i)
	}
	return p
}

func newBuf() []byte {
	b := make([]byte, W*H)
	for i := range b {
		b[i] = EMPTY
	}
	return b
}

func maxTile(words []int) int {
	m := -1
	for _, w := range words {
		m = max(m, w&0x7FF)
	}
	return m
}

func drawPlane(px []byte, plane []int, tiles []byte, opaqueFill bool) {
	for r := 0; r < ROWS; r++ {
		for c := 0; c < COLS; c++ {
			word := plane[r*COLS+c]
			tile := word & 0x7FF
			hflip, vflip, line := (word>>11)&1, (word>>12)&1, (word>>13)&3
			for y := 0; y < 8; y++ {
				for x := 0; x < 8; x++ {
					sx, sy := x, y
					if hflip != 0 {
						sx = 7 - x
					}
					if vflip != 0 {
						sy = 7 - y
					}
					b := int(tiles[tile*32+sy*4+sx>>1])
					idx := b >> 4
					if sx&1 != 0 {
						idx = b & 0x0F
					}
					if idx == 0 && !opaqueFill {
						continue // 0 is transparent on plane A
					}
					px[(r*8+y)*W+(c*8+x)] = byte(line*16 + idx)
				}
			}
		}
	}
}

// usedSorted is [...new Set(values)].sort((a,b) => a-b), less EMPTY if skip.
func usedSorted(px []byte, skipEmpty bool) []int {
	var seen [256]bool
	for _, v := range px {
		seen[v] = true
	}
	var used []int
	for v, s := range seen {
		if s && !(skipEmpty && v == EMPTY) {
			used = append(used, v)
		}
	}
	return used
}

type rect struct{ x, y, w, h int }

type writer struct{ out string }

// No tRNS. The scene is opaque by definition and will happily use its lowest
// palette slot as a real colour -- reserving index 0 punches holes in it.
func (wr writer) writeOpaque(px []byte, colours [][3]byte, file string) {
	unwritten := 0
	for _, v := range px {
		if v == EMPTY {
			unwritten++
		}
	}
	if unwritten != 0 {
		panic(fmt.Sprintf("%s: %d pixels never written", file, unwritten))
	}
	used := usedSorted(px, false)
	var remap [256]byte
	pal := make([][3]byte, len(used))
	for i, v := range used {
		remap[v] = byte(i)
		pal[i] = colours[v]
	}
	idx := make([]byte, len(px))
	for i, v := range px {
		idx[i] = remap[v]
	}
	data := lib.EncodeIndexedPNG(idx, W, H, pal, -1)
	lib.WriteFile(wr.out, file, data)
	fmt.Printf("%-18s %dx%d  %6dB  %d colours\n", file, W, H, len(data), len(used))
}

// writeOverlay is an overlay: index 0 transparent, cropped to what it covers unless `full`.
func (wr writer) writeOverlay(px []byte, colours [][3]byte, file string, full bool) rect {
	x0, y0, x1, y1 := W, H, -1, -1
	if full {
		x0, y0, x1, y1 = 0, 0, W-1, H-1
	} else {
		for y := 0; y < H; y++ {
			for x := 0; x < W; x++ {
				if px[y*W+x] != EMPTY {
					x0, x1, y0, y1 = min(x0, x), max(x1, x), min(y0, y), max(y1, y)
				}
			}
		}
	}
	if x1 < 0 {
		panic(file + ": empty")
	}
	r := rect{x0, y0, x1 - x0 + 1, y1 - y0 + 1}
	crop := make([]byte, 0, r.w*r.h)
	for y := 0; y < r.h; y++ {
		crop = append(crop, px[(r.y+y)*W+r.x:(r.y+y)*W+r.x+r.w]...)
	}
	entries := usedSorted(crop, true)
	var remap [256]byte
	pal := [][3]byte{{0, 0, 0}}
	for i, v := range entries {
		remap[v] = byte(i + 1)
		pal = append(pal, colours[v])
	}
	idx := make([]byte, r.w*r.h)
	for i, v := range crop {
		if v != EMPTY {
			idx[i] = remap[v]
		}
	}
	data := lib.EncodeIndexedPNG(idx, r.w, r.h, pal, 0)
	lib.WriteFile(wr.out, file, data)
	fmt.Printf("%-18s %3dx%3d @%d,%d  %6dB  %d col\n", file, r.w, r.h, r.x, r.y, len(data), len(entries))
	return r
}

// picture is one opening frame: its pixels and the palette they are shown in.
type picture struct {
	px      []byte
	colours [][3]byte
}

func Build(out string) {
	wr := writer{lib.OutDir(out)}

	art, _ := lib.KosDecode(lib.Rom("S3_Sonic_D.kos"), 0)
	planeB := lib.EniDecode(lib.Rom("S3_BG.eni"), 0x4000)      // palette line 2
	planeA := lib.EniDecode(lib.Rom("S3_Sonic_D.eni"), 0x8000) // priority 1
	palRaw := lib.Rom("S3_Sonic_D.bin")

	if len(art)%32 != 0 {
		panic(fmt.Sprintf("art is not tile-aligned: %d bytes", len(art)))
	}
	if len(planeB) != 40*28 {
		panic(fmt.Sprintf("plane B is %d words, expected 1120", len(planeB)))
	}
	if len(planeA) != 40*28 {
		panic(fmt.Sprintf("plane A is %d words, expected 1120", len(planeA)))
	}
	if m := maxTile(slices.Concat(planeA, planeB)); m >= len(art)/32 {
		panic(fmt.Sprintf("tile %d referenced but art has only %d", m, len(art)/32))
	}

	pal := make([][3]byte, 64)
	for i := range pal {
		pal[i] = colour(palRaw, i)
	}

	// ---- the settled title: what the page shows when nothing is animating ----
	px := newBuf()
	drawPlane(px, planeB, art, true)  // sky and scenery: index 0 is a real colour here
	drawPlane(px, planeA, art, false) // Sonic on top, index 0 lets plane B through
	wr.writeOpaque(px, pal, "s3-back.png")

	// The same two planes kept apart, because Tails' plane flies between them.
	px = newBuf()
	drawPlane(px, planeB, art, true)
	wr.writeOpaque(px, pal, "s3-plane-b.png")
	px = newBuf()
	drawPlane(px, planeA, art, false)
	wr.writeOverlay(px, pal, "s3-plane-a.png", true)

	// ---- the opening (Title_Screen, sonic3k.asm) ---------------------------------
	// TitleSonic_Frames: thirteen full-screen pictures, each its own Enigma map and
	// palette over one of seven Kosinski art blocks. Frames 1-7 share frame 1's
	// tiles -- TitleSonic_LoadFrame skips the DMA below 7 -- and so does frame 8 in
	// a sense, since its art is queued while 1-7 play. Both nametables point at the
	// same buffer, so planes A and B show one picture and colour 0 is the backdrop.
	ART := map[string][]byte{}
	artOf := func(n string) []byte {
		if ART[n] == nil {
			ART[n], _ = lib.KosDecode(lib.Rom("S3_Sonic_"+n+".kos"), 0)
		}
		return ART[n]
	}
	frameArt := func(n string) []byte {
		if strings.Contains("1234567", n) {
			return artOf("1")
		}
		return artOf(n)
	}
	frame := func(n string) picture {
		m := lib.EniDecode(lib.Rom("S3_Sonic_"+n+".eni"), 0)
		tiles := frameArt(n)
		if maxTile(m) >= len(tiles)/32 {
			panic("frame " + n + " references tiles past its art")
		}
		o := newBuf()
		for r := 0; r < ROWS; r++ {
			for c := 0; c < COLS; c++ {
				word := m[r*COLS+c]
				tile := word & 0x7FF
				hf, vf, line := (word>>11)&1, (word>>12)&1, (word>>13)&3
				for y := 0; y < 8; y++ {
					for x := 0; x < 8; x++ {
						sx, sy := x, y
						if hf != 0 {
							sx = 7 - x
						}
						if vf != 0 {
							sy = 7 - y
						}
						b := int(tiles[tile*32+sy*4+sx>>1])
						idx := b >> 4
						if sx&1 != 0 {
							idx = b & 0x0F
						}
						v := 0
						if idx != 0 {
							v = line*16 + idx
						}
						o[(r*8+y)*W+c*8+x] = byte(v)
					}
				}
			}
		}
		return picture{o, palOf(lib.Rom("S3_Sonic_" + n + ".bin"))}
	}

	var seq []*lib.Obj
	put := func(file string, f picture, dur int, note string) {
		wr.writeOpaque(f.px, f.colours, file)
		seq = append(seq, lib.O("file", file, "dur", dur, "note", note))
	}
	next := func() string { return fmt.Sprintf("s3-i%02d.png", len(seq)) }

	// Pal_Title: after the SEGA chant, seven colours a frame until the backdrop is
	// black. The first step is frame 1's own palette, so it doubles as the logo.
	fade := lib.Rom("S3_Title_Fade.bin")
	STEPS := len(fade) / 14
	logo := frame("1")
	for s := 0; s < STEPS; s++ {
		colours := slices.Clone(logo.colours)
		for i := 0; i < 7; i++ {
			colours[i] = colour(fade, s*7+i)
		}
		note := "logo"
		if s != 0 {
			note = "fade"
		}
		put(next(), picture{logo.px, colours}, 1, note)
	}
	if at(fade, (STEPS-1)*14)<<8|at(fade, (STEPS-1)*14+1) != 0 {
		panic("fade does not end on a black backdrop")
	}

	// TitleAnim_FlipBuffer flips every 4th frame and Iterate_TitleSonicFrame loads
	// the next picture two frames ahead of it, so each shows for 4. The last one,
	// frame C, gets 3: SonicFrameIndex hits $FF on the next load slot and the loop
	// exits there, a frame before its flip would have come round.
	FLIPS := []string{"2", "3", "4", "5", "6", "7", "8", "9", "A", "B", "C"}
	for i, n := range FLIPS {
		dur := 4
		if i == len(FLIPS)-1 {
			dur = 3
		}
		put(next(), frame(n), dur, "frame "+n)
	}

	// Then the palette is flooded with $EEE. It stays white until FlipBuffer's
	// next copy from Target_palette three frames later. (The ROM is decompressing
	// frame D's 650 tiles meanwhile, and what that stall shows on hardware is not
	// modelled -- the flash cuts straight to the settled screen.)
	white := make([]byte, W*H)
	put(next(), picture{white, [][3]byte{colour([]byte{0x0E, 0xEE}, 0)}}, 3, "flash")

	// ---- the title objects, once the screen has settled ---------------------------
	// ArtNem_Title_SonicSprites at ArtTile_Title_Misc; mapping tiles index from it.
	spr := lib.NemDecode(lib.Rom("S3_Sonic_Sprites.nem"))
	if len(spr)%32 != 0 {
		panic("sprite art is not tile-aligned")
	}
	sonicMap := lib.ParseMapFrames(string(lib.Rom("S3_SonicAnim_map.asm")))
	tailsMap := lib.ParseMapFrames(string(lib.Rom("S3_TailsPlane_map.asm")))

	// Obj_TitleSonicFinger and Obj_TitleSonicWink: palette line 1, high priority, so
	// drawn over plane A. Mapping frame 4 is empty -- plane A's own pose shows.
	patch := func(frameNo, objX, objY int, file string) *lib.Obj {
		b := newBuf()
		lib.DrawSprite(b, W, H, sonicMap[frameNo], spr, objX, objY, 1, false)
		r := wr.writeOverlay(b, pal, file, false)
		return lib.O("file", file, "x", r.x, "y", r.y)
	}
	const EMPTY_FRAME = 4
	if len(sonicMap[EMPTY_FRAME]) != 0 {
		panic("Sonic anim frame 4 is expected to be empty")
	}
	// Ani_TitleSonicFinger: one delay byte (5, so 6 frames a step), then the frames.
	FINGER_SEQ := []int{4, 4, 4, 4, 4, 4, 0, 4, 1, 4, 0, 4, 1, 4, 0, 4, 1, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4}
	// Ani_TitleSonicWink, via Animate_SpriteIrregularDelay: (frame, delay) pairs,
	// each shown for delay+1.
	WINK_STEPS := [][2]int{{2, 1}, {3, 7}, {2, 5}, {4, 0x67}, {4, 0x2F}}
	type channel struct {
		x, y    int
		patches *lib.Obj
		steps   [][2]int
	}
	finger := &channel{x: 0x148, y: 0xDC, patches: lib.O()}
	for _, f := range FINGER_SEQ {
		finger.steps = append(finger.steps, [2]int{f, 6})
	}
	wink := &channel{x: 0xF8, y: 0xC8, patches: lib.O()}
	for _, s := range WINK_STEPS {
		wink.steps = append(wink.steps, [2]int{s[0], s[1] + 1})
	}
	for _, nc := range []struct {
		name string
		ch   *channel
	}{{"finger", finger}, {"wink", wink}} {
		ch := nc.ch
		period := 0
		for _, s := range ch.steps {
			f := s[0]
			if key := fmt.Sprint(f); f != EMPTY_FRAME && !ch.patches.Has(key) {
				ch.patches.Set(key, patch(f, ch.x, ch.y, fmt.Sprintf("s3-%s%d.png", nc.name, f)))
			}
			period += s[1]
		}
		fmt.Printf("  %-7s %d steps, %d frames a loop\n", nc.name, len(ch.steps), period)
	}
	chObj := func(ch *channel) *lib.Obj {
		return lib.O("x", ch.x, "y", ch.y, "patches", ch.patches, "steps", ch.steps)
	}

	// Obj_TitleTailsPlane: palette line 3, LOW priority -- in front of plane B but
	// behind plane A, so it passes behind Sonic and the ring. It flies right at
	// y $C0 a pixel a frame from x 0 to $240, turns (hflip) and comes back at $D0.
	// Its y is not offset by V_scroll, unlike everything else on the screen.
	// Rendered at a fixed point and stored as offsets from the object's position.
	const RX, RY = 0x80 + 160, 0x80 + 112
	type tailsView struct {
		file      string
		dx, dy, w int
	}
	var frames [][2]tailsView
	for f := range tailsMap {
		var pair [2]tailsView
		for i, flip := range []bool{false, true} {
			b := newBuf()
			lib.DrawSprite(b, W, H, tailsMap[f], spr, RX, RY, 3, flip)
			dir := "r"
			if flip {
				dir = "l"
			}
			file := fmt.Sprintf("s3-tails%d%s.png", f, dir)
			r := wr.writeOverlay(b, pal, file, false)
			pair[i] = tailsView{file, r.x - (RX - 0x80), r.y - (RY - 0x80), r.w}
		}
		frames = append(frames, pair)
	}
	var framesJSON [][]*lib.Obj
	for _, p := range frames {
		var pj []*lib.Obj
		for _, v := range p {
			pj = append(pj, lib.O("file", v.file, "dx", v.dx, "dy", v.dy, "w", v.w))
		}
		framesJSON = append(framesJSON, pj)
	}
	const tailsDur = 2
	tails := lib.O("x0", 0, "turn", 0x240, "yOut", 0xC0, "yBack", 0xD0, "dur", tailsDur, "frames", framesJSON)
	// Ani_TitleTailsPlane: delay 1, so each mapping frame shows for 2.
	// The first pass is over once its left edge clears the right of the screen.
	lead := frames[0][0].dx
	for _, p := range frames {
		lead = min(lead, p[0].dx)
	}
	tailsGone := (W + 0x80 - lead) - 1 // x = k+1 on object frame k
	fmt.Printf("  tails   %d frames x %d, first pass leaves at frame %d\n", len(frames), tailsDur, tailsGone)

	// Obj_TitleBanner_Display rotates Pal_TitleWaterRot into line 3 colours 13-14
	// for the banner's water. Tails shares line 3, so check he never uses them.
	for _, pieces := range tailsMap {
		b := newBuf()
		lib.DrawSprite(b, W, H, pieces, spr, RX, RY, 3, false)
		if slices.Contains(b, 0x3D) || slices.Contains(b, 0x3E) {
			panic("Tails uses the water-cycle colours")
		}
	}

	meta := lib.O("seq", seq, "finger", chObj(finger), "wink", chObj(wink), "tails", tails, "tailsGone", tailsGone)
	lib.WriteFile(wr.out, "s3-intro-meta.json", []byte(lib.StringifyIndent(meta, " ")))

	// Reference only: the logo tiles, so the real 3's flat top bar and chamfers can
	// be read off. Nothing here is embedded -- the digits were drawn against it.
	bart := lib.NemDecode(lib.Rom("S3_Banner.nem"))
	if len(bart)%32 != 0 {
		panic("banner art is not tile-aligned")
	}
	const BCOLS, S = 16, 3
	tiles := len(bart) / 32
	BROWS := (tiles + BCOLS - 1) / BCOLS
	BW, BH := BCOLS*8*S, BROWS*8*S
	bpx := make([]byte, BW*BH)
	for t := 0; t < tiles; t++ {
		cx, cy := (t%BCOLS)*8, t/BCOLS*8
		for y := 0; y < 8; y++ {
			for x := 0; x < 8; x++ {
				b := bart[t*32+y*4+x>>1]
				v := b >> 4
				if x&1 != 0 {
					v = b & 0x0F
				}
				for sy := 0; sy < S; sy++ {
					for sx := 0; sx < S; sx++ {
						bpx[((cy+y)*S+sy)*BW+(cx+x)*S+sx] = v
					}
				}
			}
		}
	}
	// Obj_TitleBanner draws with make_art_tile(..., 3, 1) -- palette line 3
	bpal := make([][3]byte, 16)
	for i := range bpal {
		bpal[i] = colour(palRaw, 48+i)
	}
	lib.WriteFile(wr.out, "s3-banner-tiles.png", lib.EncodeIndexedPNG(bpx, BW, BH, bpal, 0))
	fmt.Printf("s3-banner-tiles.png %dx%d  %d tiles (reference, not embedded)\n", BW, BH, tiles)
}
