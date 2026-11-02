package s2

import (
	"fmt"
	"slices"
	"strings"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// what the card hands on to Emerald Hill
type cardResult struct {
	tl                                          []*lib.Obj
	rest, loaded, objsFrom, mainFrom, plcFrames int
	pal                                         []int
	cam                                         struct{ x, y int }
}

type kglyph struct {
	w    int
	px   []int
	from string
}

// block is a column-major block of tiles, 16 rows tall: what a 2-tall sprite piece draws.
func block(art []byte, t, wt int) kglyph {
	const ht = 2
	w, h := wt*8, ht*8
	px := make([]int, w*h)
	for cx := 0; cx < wt; cx++ {
		for cy := 0; cy < ht; cy++ {
			for y := 0; y < 8; y++ {
				for x := 0; x < 8; x++ {
					b := 0 // past the art's end: undefined, so 0
					if i := (t+cx*ht+cy)*32 + y*4 + (x >> 1); i < len(art) {
						b = int(art[i])
					}
					c := b >> 4
					if x&1 != 0 {
						c = b & 15
					}
					px[(cy*8+y)*w+cx*8+x] = c
				}
			}
		}
	}
	return kglyph{w: w, px: px}
}

// The face is white (6), anti-aliased grey (7, 8), with a black drop shadow two pixels right and two
// down wherever the face is not. Checked against the real letters; the drawn glyphs get it too.
func kshadow(rows []string) kglyph {
	w, h := len(rows[0]), 16
	px := make([]int, w*h)
	face := func(x, y int) bool { return y >= 0 && y < len(rows) && x >= 0 && x < w && rows[y][x] != '.' }
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if face(x, y) {
				px[y*w+x] = 6 // +rows[y][x] || 6
				if c := rows[y][x]; c >= '1' && c <= '9' {
					px[y*w+x] = int(c - '0')
				}
			} else if face(x-2, y-2) {
				px[y*w+x] = 1
			}
		}
	}
	return kglyph{w: w, px: px}
}

// ==== the title card ==================================================================================
// Obj34 over ArtNem_TitleCard (tiles $580-$5DD: E N O Z, the act numbers, SONIC THE HEDGEHOG, the red
// stripes and the three fill tiles) and the letter font ArtNem_TitleCard2, which LoadTitleCard copies
// into VRAM a zone's letters at a time. Palette lines 0 and 1 are Pal_BGND's, loaded for the card.
func buildCard(out string) *cardResult {
	cardArt := make([]byte, 0x800*32)
	copy(cardArt[0x580*32:], lib.NemDecode(rd("S2_TitleCard.nem")))
	letterArt := lib.NemDecode(rd("S2_TitleCard2.nem"))
	cardPal := append(lib.Words(rd("S2_Pal_SonicAndTails.bin")), lib.Words(rd("S2_Pal_SonicAndTails2.bin"))...)
	// The font's letters, at the offsets the title-card charset gives them -- each 2x2 tiles, I 1x2, M
	// and W 3x2 -- and E N O Z, which the base art holds for ZONE. B, J, Q, V and X spell no zone, but
	// they are in the font. (The atlas is laid out in sorted key order, so a map does here.)
	kglyphs := map[string]kglyph{}
	LETTER := map[string]int{"A": 0, "B": 4, "C": 8, "D": 0xC, "F": 0x10, "G": 0x14, "H": 0x18, "I": 0x1C, "J": 0x1E, "K": 0x22, "L": 0x26, "M": 0x2A,
		"P": 0x30, "Q": 0x34, "R": 0x38, "S": 0x3C, "T": 0x40, "U": 0x44, "V": 0x48, "W": 0x4C, "X": 0x52, "Y": 0x56}
	for c, t := range LETTER {
		wt := 2
		if c == "I" {
			wt = 1
		} else if c == "M" || c == "W" {
			wt = 3
		}
		g := block(letterArt, t, wt)
		g.from = "card"
		kglyphs[c] = g
	}
	for c, t := range map[string]int{"E": 0x580, "N": 0x584, "O": 0x588, "Z": 0x58C} {
		g := block(cardArt, t, 2)
		g.from = "card"
		kglyphs[c] = g
	}
	dot := block(letterArt, 0x5A, 1)
	dot.from = "card"
	kglyphs["."] = dot
	{
		hit, all := 0, 0
		for _, c := range "ADEHLT" {
			g := kglyphs[string(c)]
			rows := make([]string, 16)
			for y := range rows {
				var b strings.Builder
				for x := 0; x < g.w; x++ {
					if v := g.px[y*g.w+x]; v == 6 || v == 7 || v == 8 {
						b.WriteByte('6')
					} else {
						b.WriteByte('.')
					}
				}
				rows[y] = b.String()
			}
			d := kshadow(rows)
			for i := range g.px {
				if g.px[i] == 1 {
					all++
					if d.px[i] == 1 {
						hit++
					}
				}
			}
		}
		if float64(hit)/float64(all) < 0.85 {
			panic(fmt.Sprintf("the title-card shadow rule matches only %d/%d real shadow pixels", hit, all))
		}
		fmt.Printf("  card: shadow rule matches %d/%d of the real letters' shadow pixels\n", hit, all)
	}
	// The letters are a thick stem with a thin line beside it, and one-pixel bars; the digits and marks
	// are drawn the same way, square like E, L and T. 0 is O.
	kdrawn := map[string][]string{
		"1": {"..6666.6", ".66666.6", "666666.6", "..6666.6", "..6666.6", "..6666.6", "..6666.6", "..6666.6", "..6666.6", "..6666.6", "..6666.6", "..6666.6", "..6666.6", ".6666666"},
		"2": {"66666666666666", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "66666666666666", "6666.6........", "6666.6........", "6666.6........", "6666.6........", "6666.6........", "6666.6........", "66666666666666"},
		"3": {"66666666666666", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "..666666666666", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "66666666666666"},
		"4": {"6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "66666666666666", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6"},
		"5": {"66666666666666", "6666.6........", "6666.6........", "6666.6........", "6666.6........", "6666.6........", "66666666666666", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "66666666666666"},
		"6": {"66666666666666", "6666.6........", "6666.6........", "6666.6........", "6666.6........", "6666.6........", "66666666666666", "6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "66666666666666"},
		"7": {"66666666666666", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........6666.6", "........666666"},
		"8": {"66666666666666", "6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "66666666666666", "6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "6666.6..6666.6", "66666666666666"},
		"!": {"6666.6", "6666.6", "6666.6", "6666.6", "6666.6", "6666.6", "6666.6", "6666.6", "6666.6", "......", "......", "......", "666666", "666666"},
		"?": {"66666666666666", "6666.6..6666.6", "6666.6..6666.6", "........6666.6", "........6666.6", "........6666.6", "....6666666666", "....6666.6....", "....6666.6....", "....6666.6....", "..............", "..............", "....666666....", "....666666...."},
		"'": {"6666.6", "6666.6", "6666.6", "6666.6", "6666.6"},
		",": {"......", "......", "......", "......", "......", "......", "......", "......", "......", "......", "......", "......", "666666", "666666", "..66..", ".66..."},
		"-": {"........", "........", "........", "........", "........", "........", "66666666", "66666666"},
		":": {"......", "......", "......", "666666", "666666", "......", "......", "......", "......", "......", "......", "......", "666666", "666666"},
		"&": {".6666666666...", ".6666.6.666...", ".6666.6.666...", "..666666666...", "6666.6.666....", "6666.6..666...", "6666.6...666.6", "6666.6....6666", "6666.6....666.", "6666.6...6666.", "6666.6..666666", "6666.6.666..66", "66666666666..6", "66666666666..."},
	}
	kdrawn["9"] = reverseRows(kdrawn["6"])
	for c, rows := range kdrawn {
		g := kshadow(rows)
		g.from = "drawn"
		kglyphs[c] = g
	}
	zero := kglyphs["O"]
	zero.from = "card"
	kglyphs["0"] = zero

	korder := make([]string, 0, len(kglyphs))
	for c := range kglyphs {
		korder = append(korder, c)
	}
	slices.Sort(korder)
	KW := 0
	for _, c := range korder {
		KW += kglyphs[c].w + 2
	}
	katlas := make([]byte, KW*16)
	glyphs, parts := &lib.Obj{}, &lib.Obj{}
	ktable := lib.O("rowh", 16, "space", 16, "glyphs", glyphs, "parts", parts)
	kx, ndrawn := 0, ""
	for _, c := range korder {
		g := kglyphs[c]
		for y := 0; y < 16; y++ {
			for x := 0; x < g.w; x++ {
				katlas[y*KW+kx+x] = byte(g.px[y*g.w+x])
			}
		}
		glyphs.Set(c, []int{kx, 0, g.w, 16, 0})
		kx += g.w + 2
		if g.from == "drawn" {
			ndrawn += c
		}
	}
	cardRgb := colours(cardPal)
	lib.WriteFile(out, "s2card-atlas.png", lib.EncodeIndexedPNG(katlas, KW, 16, cardRgb[:16], 0))
	// ZONE ($11), the act numbers ($12-$14), SONIC THE HEDGEHOG ($15) and the red stripes ($16), from
	// MapUnc_TitleCards; and the three tiles DrawLevelTitleCard fills plane A with -- blue $5DA, red
	// $5D8 stacked down a column, yellow $5DC -- as the areas they cover.
	// (the zone-name frames come first, through zoneOffsetTableEntry, which this skips: the six after them)
	cframes := lib.ParseS1MapFrames(string(rd("S2_TitleCards_map.asm")))
	if len(cframes) != 6 {
		panic("expected the six frames after the zone names")
	}
	writePart := func(name string, r *lib.Rendered) {
		lib.WriteFile(out, "s2card-"+name+".png", lib.EncodeIndexedPNG(r.Px, r.W, r.H, cardRgb, 0))
		parts.Set(name, lib.O("ox", r.Ox, "oy", r.Oy, "w", r.W, "h", r.H))
	}
	for i, name := range []string{"zone", "act1", "act2", "act3", "sth", "stripes"} {
		writePart(name, lib.RenderFrame(cframes[i], cardArt, lib.RenderOpts{}))
	}
	fill := func(t, w, h int, vertical bool, line int) *lib.Rendered {
		px := make([]byte, w*h)
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				tt := t + ((x >> 3) & 1)
				if vertical {
					tt = t + ((y >> 3) & 1)
				}
				b := cardArt[tt*32+(y&7)*4+((x&7)>>1)]
				c := b >> 4
				if x&1 != 0 {
					c = b & 15
				}
				if c != 0 {
					px[y*w+x] = byte(line*16) + c
				}
			}
		}
		return &lib.Rendered{Px: px, W: w, H: h}
	}
	writePart("blue", fill(0x5DA, 320, 224, false, 0))
	writePart("red", fill(0x5D8, 112, 224, true, 0))
	writePart("yellow", fill(0x5DC, 320, 64, false, 1))

	card := runObj34()
	card.pal = cardPal
	ktable.Set("card", lib.O("tl", card.tl, "rest", card.rest, "loaded", card.loaded, "objsFrom", card.objsFrom,
		"mainFrom", card.mainFrom, "plcFrames", card.plcFrames, "name", lib.O("right", 128, "y", 56), "zone", lib.O("y", 80),
		"act", lib.O("y", 80), "sth", lib.O("y", 160), "stripes", lib.O("y", 112)))
	lib.WriteFile(out, "s2card-table.json", []byte(lib.Stringify(ktable)))
	fmt.Printf("s2card-atlas.png %dx16  %d glyphs (%s drawn); %d card frames, at rest on %d, level from %d\n",
		KW, len(korder), ndrawn, len(card.tl), card.rest, card.loaded)
	return card
}

// one of Obj34's pieces
type cardObj struct {
	k                                   string
	x, to, from, wait, first, loc, hold int
	dead                                bool // alive === false
}

// ---- Obj34, run frame by frame -----------------------------------------------------------------
// Six objects from Obj34_TitleCardData, in slot order: the zone name, ZONE, the act number, the blue
// background, the yellow bottom part, the red left part. Each waits its count (Obj34_Wait), then
// moves $10 a frame to its target; the background and the two bands also write plane A, which
// DrawLevelTitleCard turns into rows and columns of their fill tiles. Sprites show only while their
// x is within VDP $0-$200. Coordinates here are screen pixels, sprite x less 128.
func runObj34() *cardResult {
	PLC_TILES := []int{24, 8, 20, 28, 38, 22, 16, 60, 32, 34} // PlrList_Ehz1 then PlrList_Std2, from each file's header
	plcFrames := 0
	for _, n := range PLC_TILES {
		plcFrames += (n + 5) / 6 // ProcessDPLC: 6 patterns a frame
	}
	r := &cardResult{plcFrames: plcFrames}
	r.cam.x, r.cam.y = 0, 0x28F-0x60 // EHZ1's start, less $A0 and $60, clamped at 0
	name := &cardObj{k: "name", x: 448, to: 160, from: 448, wait: 0x1B, first: 2}
	zone := &cardObj{k: "zone", x: -88, to: 200, from: -88, wait: 0x1C, first: 1}
	act := &cardObj{k: "act", x: -24, to: 264, from: -24, wait: 0x1C, first: 1}
	bottom := &cardObj{k: "bottom", x: 552, to: 232, from: 552, wait: 8, first: 1, loc: 0x26}
	left := &cardObj{k: "left", x: -128, to: 112, from: -128, wait: 0x15, first: 1, loc: 0}
	o := []*cardObj{name, zone, act, bottom, left}
	texts := o[:3]
	bgLoc, bgInit, bgRows, red := 0, false, 0, 0 // bgInit: the JS's bgLoc === 'init'
	var yel, reveal any                          // null or a number
	shown := map[string]bool{}
	vis := func(x int) bool { return x+128 >= 0 && x+128 <= 0x200 }
	towards := func(e *cardObj, to, v int) {
		if e.x != to {
			if e.x < to {
				e.x += v
			} else {
				e.x -= v
			}
		}
		shown[e.k] = vis(e.x)
	}
	waitDone := func(e *cardObj) bool {
		if e.wait > 1 {
			e.wait--
			return false
		}
		e.wait = 1
		return true
	}
	record := func(extra ...any) {
		rec := lib.O("bg", bgRows, "yel", yel, "red", red, "reveal", reveal)
		for _, e := range o {
			if shown[e.k] && !e.dead {
				rec.Set(e.k, e.x)
			}
		}
		for i := 0; i < len(extra); i += 2 {
			rec.Set(extra[i].(string), extra[i+1])
		}
		r.tl = append(r.tl, rec)
	}
	r.tl = append(r.tl, lib.O("none", 1)) // frame 0: before the card exists
	f, rest := 0, -1
	for { // Level_TtlCard
		f++
		for _, e := range texts {
			if f < e.first {
				continue
			}
			shown[e.k] = false
			if waitDone(e) {
				towards(e, e.to, 16)
			}
		}
		if bgLoc != 0x10 {
			bgLoc++
			bgRows = bgLoc * 2
		}
		{
			e := bottom
			shown["bottom"] = false
			if waitDone(e) {
				if e.loc >= 0 {
					yel = e.loc
					if e.loc -= 2; e.loc == 6 {
						e.loc = -1
					}
				}
				towards(e, e.to, 16)
			}
		}
		{
			e := left
			shown["left"] = false
			if waitDone(e) {
				if e.loc >= 0 {
					e.loc += 2
					red = e.loc
					if e.loc == 0xE {
						e.loc = -1
					}
				}
				towards(e, e.to, 16)
			}
		}
		record()
		if name.x == name.to && rest < 0 {
			rest = len(r.tl) - 1
		}
		if name.x == name.to && f >= 1+plcFrames {
			break
		}
	}
	r.rest = rest
	r.loaded = len(r.tl)
	record() // the WaitForVint before Hud_Base
	// the level loads here, in no frames this page models; then the card goes
	left.loc = 0xA
	bottomOut, bgOut, bgDone := false, false, false
	r.objsFrom = len(r.tl)
	for !bgDone {
		// slot order: the background, then the bottom part, then the left part
		if bgOut {
			if bgInit {
				bgLoc, bgInit = 0xF0-0x20, false
			} else {
				bgLoc -= 0x20
			}
			if bgLoc == -0x30 {
				bgDone = true
			} else {
				reveal = bgLoc - (r.cam.y & 15)
			}
		}
		if bottomOut && !bottom.dead {
			e := bottom
			if e.loc == 0x28 {
				bgOut, bgInit = true, true
				e.dead = true
				shown["bottom"] = false
				yel = nil
			} else {
				if e.loc+4 >= 40 {
					yel = nil
				} else {
					yel = e.loc + 4
				}
				e.loc += 4
				towards(e, e.from, 32)
			}
		}
		if !left.dead {
			e := left
			if e.loc < 0 {
				bottomOut = true
				bottom.loc = 0
				e.dead = true
				shown["left"] = false
			} else {
				red = e.loc
				y := 40 // yel ?? 40
				if yel != nil {
					y = yel.(int)
				}
				yel = min(y, e.loc)
				if e.loc -= 4; e.loc == -2 {
					e.loc = 0
				}
				towards(e, e.from, 32)
			}
		}
		record("objs", 1)
	}
	r.mainFrom = len(r.tl)
	for _, e := range texts {
		e.hold = 0x2D
	}
	anyAlive := func() bool {
		for _, e := range texts {
			if !e.dead {
				return true
			}
		}
		return false
	}
	for anyAlive() {
		for _, e := range texts {
			if e.dead {
				continue
			}
			if e.hold != 0 {
				e.hold--
				shown[e.k] = vis(e.x)
				continue
			}
			if e.x == e.from {
				e.dead = true
				shown[e.k] = false
				continue
			}
			if e.x < e.from {
				e.x += 32
			} else {
				e.x -= 32
			}
			if !vis(e.x) {
				e.dead = true
				shown[e.k] = false
				continue
			}
			shown[e.k] = true
		}
		record("objs", 1, "main", len(r.tl)-r.mainFrom)
	}
	return r
}
