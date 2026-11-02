package s1

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

var reCardPiece = regexp.MustCompile(`(?m)spritePiece\s+([^;\n]+);\s*([A-Z])\s*$`)

// ---- the Sonic 1 title card ----------------------------------------------------------------
// Object $34 over Nem_TitleCard, palette line 0 (Sonic's), high priority. Its letters are
// read off Map_Card's commented pieces like the credits: 16px apart, I 8 wide, a 16px gap
// between words. The art also holds a K, a U and a full stop no card ever spells; they are
// the game's, so they are used.
func buildCard(out string) {
	cardArt := lib.NemDecode(lib.Rom("S1_TitleCards.nem"))
	cardMapText := string(lib.Rom("S1_TitleCards_map.asm"))
	cardFrames := lib.ParseS1MapFrames(cardMapText)
	order, kfound := pieceKeys(reCardPiece, cardMapText)
	for _, kv := range [][2]string{{"K", "2,2,$22"}, {"U", "2,2,$46"}, {".", "1,1,$52"}} {
		if kfound[kv[0]] == nil {
			order = append(order, kv[0])
		}
		kfound[kv[0]] = &keySet{kv[1]}
	}
	kglyphs := map[string]glyph{}
	for _, ch := range order {
		keys := *kfound[ch]
		if len(keys) > 1 {
			panic(fmt.Sprintf("title card %s has %d tile sets", ch, len(keys)))
		}
		r := pieceGlyph(keys[0], cardArt)
		if ch == "." { // a 1x1 piece: sit it on the baseline
			px := make([]byte, 8*16)
			copy(px[8*8:], r.Px[:64])
			r = &lib.Rendered{W: 8, Px: px}
		}
		kglyphs[ch] = glyph{r.W, low4(r.Px), "title card"}
	}
	fmt.Printf("  S1 card: %s decoded\n", strings.Join(sortedKeys(kglyphs), ""))

	{
		A := rowsOf(faceOf(kglyphs["A"]))
		bar := slices.IndexFunc(A, func(r []int) bool { return countNonzero(r) >= 9 })
		vRows := make([][]int, len(A))
		for y, r := range A {
			vRows[y] = r
			if y == bar {
				vRows[y] = make([]int, len(r))
				for x, v := range r {
					if !(x > 2 && x < 10) {
						vRows[y][x] = v
					}
				}
			}
		}
		V := vflip(fromRows(vRows))
		Y := rowsOf(faceOf(kglyphs["Y"]))[:8]
		U := rowsOf(faceOf(kglyphs["U"]))
		jRows := make([][]int, len(U))
		for y, r := range U {
			jRows[y] = r
			if y < 11 {
				jRows[y] = make([]int, len(r))
				for x, v := range r {
					if x >= 5 {
						jRows[y][x] = v
					}
				}
			}
		}
		yRev := slices.Clone(Y)
		slices.Reverse(yRev)
		xRows := append(slices.Clone(Y), yRev...)
		type entry struct {
			c string
			g glyph
		}
		kd := []entry{
			{"V", shadow(V)}, // A turned over, its bar taken out
			{"W", shadow(vflip(faceOf(kglyphs["M"])))}, // M turned over
			{"X", shadow(fromRows(xRows))},             // Y's open top, and again below
			{"J", shadow(fromRows(jRows))},             // U, left stem cut
			{"Q", shadow(overlay(faceOf(kglyphs["O"]), face(16, kseg(9.5, 11.5, 14.5, 15.5))))}, // O and a tail
			{"0", kglyphs["O"]},
			{"1", shadow(face(10, kbox(4, 0, 7, 15), kseg(1.5, 3.5, 5, 0.8), kbox(2, 14, 9, 15)))},
			{"2", shadow(face(14, karc(6.5, 4.2, 4.5, 3.8, 180, 50), kseg(10, 6.8, 2, 14.2), kbox(1.5, 13.5, 12, 15)))},
			{"3", shadow(face(14, karc(6.4, 3.8, 4.4, 3.2, 200, 90), karc(6.6, 10.6, 5.0, 4.0, 270, 160)))},
			{"4", shadow(face(14, kbox(8.5, 0, 11.5, 15), kseg(9.5, 0.8, 1.8, 10.2), kbox(1, 9.6, 13, 11.4)))},
			{"5", shadow(face(14, kbox(2, 0, 11.5, 2), kbox(2, 0, 4.5, 6.6), karc(6.4, 10.2, 5.2, 4.4, 230, 150)))},
			{"6", shadow(face(14, karc(6.6, 10.6, 4.8, 4.0, 0, 360), karc(10.4, 10.6, 8.6, 9.8, 180, 270)))},
			{"7", shadow(face(14, kbox(1.5, 0, 12.5, 2), kseg(11.6, 1.5, 5, 15)))},
			{"8", shadow(face(14, karc(6.6, 3.6, 3.8, 3.0, 0, 360), karc(6.6, 10.6, 5.0, 4.0, 0, 360)))},
			{"!", shadow(face(6, kbox(2, 0, 4.5, 10.5), kbox(2, 13, 4.5, 15)))},
			{"?", shadow(face(13, karc(6, 4, 4.4, 3.6, 180, 100), kbox(5, 7.5, 7.5, 10.5), kbox(5, 13, 7.5, 15)))},
			{"'", shadow(face(6, kbox(2, 0, 4.5, 5)))},
			{",", shadow(face(6, kbox(2, 12, 4.5, 14.5), kseg(4, 14, 2.4, 15.8, 0.9)))},
			{"-", shadow(face(10, kbox(1, 7, 8, 9)))},
			{":", shadow(face(6, kbox(2, 4, 4.5, 6.5), kbox(2, 12.5, 4.5, 15)))},
			{"&", shadow(face(15, karc(6, 3.6, 3.2, 3.0, 0, 360), kseg(7.6, 6.2, 13.5, 15), karc(6, 10.8, 4.4, 4.0, 330, 215),
				kseg(4, 6.4, 2.4, 8.4), kseg(11, 9, 13.6, 7.4)))},
		}
		six := kd[slices.IndexFunc(kd, func(e entry) bool { return e.c == "6" })].g
		nine := glyph{w: six.w, px: reversed(six.px)} // 6 turned round
		for i, v := range nine.px {
			if v == 1 {
				nine.px[i] = 0
			}
		}
		kd = append(kd, entry{"9", shadow(faceOf(nine))})
		for _, e := range kd {
			if _, ok := kglyphs[e.c]; !ok {
				kglyphs[e.c] = glyph{e.g.w, e.g.px, "derived"}
			}
		}
	}
	korder := sortedKeys(kglyphs)
	KW := 0
	for _, c := range korder {
		KW += kglyphs[c].w + 2
	}
	katlas := make([]byte, KW*16)
	glyphs, parts := &lib.Obj{}, &lib.Obj{}
	ktable := lib.O("rowh", 16, "space", 16, "glyphs", glyphs, "parts", parts)
	kx := 0
	for _, c := range korder {
		g := kglyphs[c]
		for y := 0; y < 16; y++ {
			for x := 0; x < g.w; x++ {
				katlas[y*KW+kx+x] = byte(pix(g.px, y*g.w+x))
			}
		}
		glyphs.Set(c, []int{kx, 0, g.w, 16, 0})
		kx += g.w + 2
	}
	sonicPal := palOf(lib.Words(lib.Rom("S1_Pal_Sonic.bin"))[:16])
	lib.WriteFile(out, "s1card-atlas.png", lib.EncodeIndexedPNG(katlas, KW, 16, sonicPal, 0))
	// ZONE (frame 6), ACT 1-3 (7-9), the blue oval ($A), each with its offset from its origin
	for _, p := range []struct {
		name string
		f    int
	}{{"zone", 6}, {"act1", 7}, {"act2", 8}, {"act3", 9}, {"oval", 10}} {
		r := lib.RenderFrame(cardFrames[p.f], cardArt, lib.RenderOpts{})
		for i := range r.Px {
			r.Px[i] &= 15
		}
		lib.WriteFile(out, "s1card-"+p.name+".png", lib.EncodeIndexedPNG(r.Px, r.W, r.H, sonicPal, 0))
		parts.Set(p.name, lib.O("ox", r.Ox, "oy", r.Oy, "w", r.W, "h", r.H))
	}
	// Card_ItemData and Card_ConData, in screen coordinates. Names are centred on their origin,
	// which slides in from the left to x 160; across every zone ZONE rests at 160 + half the
	// name's width - 48, ACT and the oval 24 further right. ZONE starts $240 left of its rest,
	// ACT $2C0 right, the oval $C0 right. In at $10 a frame; once the act lands the level loads
	// and fades in under the static card (4 + 22 frames), Card_Wait holds 60 more, then all four
	// head back at $20 a frame. Each is drawn only while its origin is within VDP x 0-$1FF.
	ktable.Set("card", lib.O(
		"name", lib.O("y", 0xD0-0x80, "from", -0x80, "to", 0x120-0x80),
		"zone", lib.O("y", 0xE4-0x80, "rel", -48, "start", -0x240),
		"act", lib.O("y", 0xEA-0x80, "rel", -24, "start", 0x2C0),
		"oval", lib.O("y", 0xE0-0x80, "rel", -24, "start", 0xC0),
		"speedIn", 0x10, "speedOut", 0x20, "frozen", 4+22, "wait", 60, "minX", -0x80, "maxX", 0x200-0x80,
	))
	lib.WriteFile(out, "s1card-table.json", []byte(lib.Stringify(ktable)))
	fmt.Printf("s1card-atlas.png %dx16  %d glyphs (%s derived)\n", KW, len(korder), derivedOf(korder, kglyphs))
}

// White face (6) anti-aliased with greys (7, 8), and a black shadow (1) cast down and to the
// right: the shadow is wherever the face is one pixel up or one left. That lands on 86% of
// the real letters' shadow pixels -- the artist rounded some by hand -- which is close enough
// to re-shadow a derived glyph, after its old shadow is taken off.
func isFace(v int) bool { return v == 6 || v == 7 || v == 8 }

func faceOf(g glyph) glyph {
	px := make([]int, len(g.px))
	for i, v := range g.px {
		if isFace(v) {
			px[i] = v
		}
	}
	return glyph{w: g.w, px: px}
}

func shadow(g glyph) glyph {
	px := make([]int, len(g.px))
	for i, v := range g.px {
		if v != 0 {
			px[i] = v
			continue
		}
		x, y := i%g.w, i/g.w
		if (x > 0 && isFace(g.px[i-1])) || (y > 0 && isFace(g.px[i-g.w])) {
			px[i] = 1
		}
	}
	return glyph{w: g.w, px: px}
}

func vflip(g glyph) glyph {
	var px []int
	for y := 0; y < 16; y++ {
		px = append(px, cut(g.px, (15-y)*g.w, (16-y)*g.w)...)
	}
	return glyph{w: g.w, px: px}
}

func rowsOf(g glyph) [][]int {
	rows := make([][]int, 16)
	for y := range rows {
		rows[y] = cut(g.px, y*g.w, (y+1)*g.w)
	}
	return rows
}

func fromRows(rows [][]int) glyph {
	var px []int
	for _, r := range rows {
		px = append(px, r...)
	}
	return glyph{w: len(rows[0]), px: px}
}

func countNonzero(r []int) int {
	n := 0
	for _, v := range r {
		if v != 0 {
			n++
		}
	}
	return n
}

type shapeFn func(X, Y float64) bool

// faces drawn with the title-card primitives' sampling, cut into the face and its two greys
func face(w int, parts ...shapeFn) glyph {
	px := make([]int, w*16)
	for y := 0; y < 16; y++ {
		for x := 0; x < w; x++ {
			c := 0.0
			for sy := 0; sy < 8; sy++ {
				for sx := 0; sx < 8; sx++ {
					X, Y := float64(x)+(float64(sx)+0.5)/8, float64(y)+(float64(sy)+0.5)/8
					if slices.ContainsFunc(parts, func(f shapeFn) bool { return f(X, Y) }) {
						c += 1.0 / 64
					}
				}
			}
			switch {
			case c >= 0.75:
				px[y*w+x] = 6
			case c >= 0.45:
				px[y*w+x] = 7
			case c >= 0.2:
				px[y*w+x] = 8
			}
		}
	}
	return glyph{w: w, px: px}
}

// float64(...) rounds each product: Go may otherwise fuse a*b+c, which V8 on x86 never does
func kseg(x0, y0, x1, y1 float64, hw ...float64) shapeFn {
	half := 1.1
	if len(hw) > 0 {
		half = hw[0]
	}
	return func(X, Y float64) bool {
		dx, dy := x1-x0, y1-y0
		t := math.Max(0, math.Min(1, (float64((X-x0)*dx)+float64((Y-y0)*dy))/(float64(dx*dx)+float64(dy*dy))))
		return lib.Hypot(X-(x0+float64(t*dx)), Y-(y0+float64(t*dy))) <= half
	}
}

func karc(cx, cy, rx, ry, a0, a1 float64) shapeFn {
	const hw = 1.1
	return func(X, Y float64) bool {
		nx, ny := (X-cx)/rx, (Y-cy)/ry
		t := lib.Atan2(ny, nx)
		deg := t * 180 / math.Pi
		if deg < 0 {
			deg += 360
		}
		if a0 <= a1 {
			if deg < a0 || deg > a1 {
				return false
			}
		} else if deg < a0 && deg > a1 {
			return false
		}
		return math.Abs(lib.Hypot(nx, ny)-1)*lib.Hypot(rx*lib.Cos(t), ry*lib.Sin(t)) <= hw
	}
}

func kbox(x0, y0, x1, y1 float64) shapeFn {
	return func(X, Y float64) bool { return X >= x0 && X < x1 && Y >= y0 && Y < y1 }
}

func overlay(a, b glyph) glyph {
	px := make([]int, len(a.px))
	for i, v := range a.px {
		r, s := 0, 0
		if v != 0 {
			r = 9 - v
		}
		if bv := pix(b.px, i); bv != 0 {
			s = 9 - bv
		}
		if m := max(r, s); m != 0 {
			px[i] = 9 - m
		}
	}
	return glyph{w: a.w, px: px}
}
