/*
Package cardfont builds the title-card lettering -- the tall face S3&K writes
zone names in, ANGEL ISLAND ZONE -- as a second text style.

Unlike the S3 title font, this one is a decode. There is no font in the ROM
as such: each zone name is a mapping frame in Map - Title Card.asm, built from
letter pieces over that zone's own small letter set (loaded at tile $54D) and
the shared title-card art below it (Red ACT at $500, the ZONE letters at $510,
the act number at $53D, in that order, later loads winning). So the build
renders every name, splits it back into letters, and keeps one of each.

Splitting: pieces never cut a letter, but one piece can hold several -- in
MUSHROOM HILL one 32px piece is H, I and L. Words are runs of touching pieces.
Where a word has one piece per letter, those pieces give the letters' widths;
with the widths known, every other word splits by position. Every letter must
then come out pixel-identical wherever it appears, or the build stops.

The zone names spell 22 letters. J, Q, W and X never appear, so they are
derived here, in the style's own construction (see the bottom of the file).

Writes card-atlas.png (indexed, the title card's real colours) and
card-table.json (the same shape as the main font's table).
*/
package cardfont

import (
	"bytes"
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

const H = 24

func kos(f string) []byte { return lib.KosMDecode(lib.Rom(f)) }

// S3KZone is vram's default `shared`.
const S3KZone = "TitleCard_S3KZone.kosm"

// Obj_TitleCard's Queue_Kos_Module calls, in order
// `shared` is what loads at $510 over Red ACT: S3&K's file, S&K-alone's, or --
// for Sonic 3 alone, which loads nothing there -- none (""). It holds the ZONE
// letters and the banner's emblem, and only the emblem differs between the three.
func vram(zone, shared string) []byte {
	v := make([]byte, 0x600*32)
	copy(v[0x500*32:], kos("TitleCard_RedAct.kosm"))
	if shared != "" {
		copy(v[0x510*32:], kos(shared))
	}
	copy(v[0x53D*32:], kos("TitleCard_Number1.kosm"))
	if zone != "" {
		copy(v[0x54D*32:], kos("TitleCard_"+zone+".kosm"))
	}
	return v
}

type piece struct {
	p    lib.Piece
	x, w int
}

type job struct {
	name    string
	frame   lib.Frame
	v       []byte
	words   [][]piece
	letters []string
}

type glyph struct {
	w    int
	px   []byte
	from string
}

func xOf(p lib.Piece) int {
	X := p[4]<<8 | p[5]
	if X > 32767 {
		return X - 65536
	}
	return X
}
func wOf(p lib.Piece) int { return ((p[1]>>2)&3 + 1) * 8 }

// ---- the four the game never needed --------------------------------------------
// Colour indices, all palette line 0 (Sonic's, which the title card is drawn in):
// 1 face $EEE, 12 and 13 the light and mid anti-aliasing $ECC / $CAA, 15 the
// $222 block behind rows 8-23 -- the bar the name sits on, built into each glyph.
const FACE, AA1, AA2, BAR, BAR_TOP = 1, 12, 13, 15, 8

func toMask(g glyph) []string {
	rows := make([]string, H)
	for y := range rows {
		var b strings.Builder
		for x := 0; x < g.w; x++ {
			switch g.px[y*g.w+x] {
			case FACE:
				b.WriteByte('#')
			case AA1:
				b.WriteByte('a')
			case AA2:
				b.WriteByte('b')
			default:
				b.WriteByte('.')
			}
		}
		rows[y] = b.String()
	}
	return rows
}

func fromMask(rows []string, from string) glyph {
	w := len(rows[0])
	px := make([]byte, w*H)
	for y, r := range rows {
		for x := 0; x < len(r); x++ {
			var v byte
			switch c := r[x]; {
			case c == '#':
				v = FACE
			case c == 'a':
				v = AA1
			case c == 'b':
				v = AA2
			case y >= BAR_TOP:
				v = BAR
			}
			px[y*w+x] = v
		}
	}
	return glyph{w, px, from}
}

type coverage [][]float64

func newCoverage(w int) coverage {
	cov := make(coverage, H)
	for y := range cov {
		cov[y] = make([]float64, w)
	}
	return cov
}

// A diagonal stroke the way the real letters are anti-aliased. Supersampled
// coverage of a band 2.1px wide, cut at 0.8 / 0.5 / 0.1: with its centre run
// from x 1.95 to 7.95 over the 24 rows, this reproduces V's left stroke exactly.
// (strokeCov's y0 and y1 default to 0 and H; strokeCovY takes them.)
func strokeCov(w int, x0, x1 float64) coverage { return strokeCovY(w, x0, x1, 0, H) }

func strokeCovY(w int, x0, x1 float64, y0, y1 int) coverage {
	cov := newCoverage(w)
	for y := y0; y < y1; y++ {
		for sy := 0; sy < 8; sy++ {
			yy := float64(y) + (float64(sy)+0.5)/8
			c := x0 + float64((x1-x0)*(yy-float64(y0)))/float64(y1-y0)
			for x := 0; x < w; x++ {
				for sx := 0; sx < 8; sx++ {
					if math.Abs(float64(x)+(float64(sx)+0.5)/8-c) <= 1.05 {
						cov[y][x] += 1.0 / 64
					}
				}
			}
		}
	}
	return cov
}

func level(c float64) int {
	switch {
	case c >= 0.8:
		return 3
	case c >= 0.5:
		return 2
	case c >= 0.1:
		return 1
	}
	return 0
}

var (
	RANK = map[byte]int{'.': 0, 'b': 1, 'a': 2, '#': 3}
	CHAR = []byte{'.', 'b', 'a', '#'}
)

// lay strokes over a mask, keeping the stronger of the two at each pixel
func overlay(rows []string, covs ...coverage) []string {
	out := make([]string, len(rows))
	for y, r := range rows {
		b := []byte(r)
		for x := range b {
			m := RANK[b[x]]
			for _, cv := range covs {
				m = max(m, level(cv[y][x]))
			}
			b[x] = CHAR[m]
		}
		out[y] = string(b)
	}
	return out
}

func blank(w int) []string {
	rows := make([]string, H)
	for y := range rows {
		rows[y] = strings.Repeat(".", w)
	}
	return rows
}

// rows with anything but the mask characters as '.', as .replace(/[^#ab]/g, '.')
func maskOnly(r string) string {
	return strings.Map(func(c rune) rune {
		if c == '#' || c == 'a' || c == 'b' {
			return c
		}
		return '.'
	}, r)
}

func reversed(rows []string) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[len(rows)-1-i] = r
	}
	return out
}

// ---- & and punctuation, which the title card never drew -------------------------------
// Built from three primitives at the same weight and cut-offs as the strokes above:
// a segment and a box, and an elliptical arc which, run as a whole ellipse, lands
// within one shade of the real O on all but 36 of its 576 pixels. Angles are
// degrees clockwise from the right, since y runs down.
const HW = 1.05

type part func(X, Y float64) bool

func shape(w int, parts ...part) glyph {
	cov := newCoverage(w)
	for y := 0; y < H; y++ {
		for x := 0; x < w; x++ {
			c := 0.0
			for sy := 0; sy < 8; sy++ {
				for sx := 0; sx < 8; sx++ {
					X, Y := float64(x)+(float64(sx)+0.5)/8, float64(y)+(float64(sy)+0.5)/8
					for _, f := range parts {
						if f(X, Y) {
							c += 1.0 / 64
							break
						}
					}
				}
			}
			cov[y][x] = c
		}
	}
	rows := make([]string, H)
	for y, r := range cov {
		b := make([]byte, len(r))
		for x, c := range r {
			b[x] = CHAR[level(c)]
		}
		rows[y] = string(b)
	}
	return fromMask(rows, "drawn")
}

// float64(...) rounds each product: Go may otherwise fuse a*b+c, which V8 on x86 never does
func seg(x0, y0, x1, y1 float64) part {
	return func(X, Y float64) bool {
		dx, dy := x1-x0, y1-y0
		t := math.Max(0, math.Min(1, (float64((X-x0)*dx)+float64((Y-y0)*dy))/(float64(dx*dx)+float64(dy*dy))))
		return lib.Hypot(X-(x0+float64(t*dx)), Y-(y0+float64(t*dy))) <= HW
	}
}

func arc(cx, cy, rx, ry, a0, a1 float64) part {
	return func(X, Y float64) bool {
		nx, ny := (X-cx)/rx, (Y-cy)/ry
		t := lib.Atan2(ny, nx)
		deg := float64(t*180) / math.Pi
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
		return float64(math.Abs(lib.Hypot(nx, ny)-1)*lib.Hypot(float64(rx*lib.Cos(t)), float64(ry*lib.Sin(t)))) <= HW
	}
}

func box(x0, y0, x1, y1 float64) part {
	return func(X, Y float64) bool { return X >= x0 && X < x1 && Y >= y0 && Y < y1 }
}

// Build writes card-atlas.png, the card-<part>.png images and card-table.json into out.
func Build(out string) {
	out = lib.OutDir(out)

	var mp []lib.Frame
	for _, t := range lib.ParseMapTables(string(lib.Rom("TitleCard_map.asm"))) {
		if t.Name == "Map_TitleCard" {
			mp = t.Frames
		}
	}
	// Map_TitleCard frames 4.. are the zones in zone order; 3 is ZONE.
	NAMES := [][2]string{{"ANGEL ISLAND", "AIZ"}, {"HYDROCITY", "HCZ"}, {"MARBLE GARDEN", "MGZ"}, {"CARNIVAL NIGHT", "CNZ"},
		{"FLYING BATTERY", "FBZ"}, {"ICECAP", "ICZ"}, {"LAUNCH BASE", "LBZ"}, {"MUSHROOM HILL", "MHZ"}, {"SANDOPOLIS", "SOZ"},
		{"LAVA REEF", "LRZ"}, {"SKY SANCTUARY", "SSZ"}, {"DEATH EGG", "DEZ"}, {"THE DOOMSDAY", "DDZ"}, {"HIDDEN PALACE", "HPZ"}}
	var jobs []*job
	for i, n := range NAMES {
		jobs = append(jobs, &job{name: n[0], frame: mp[4+i], v: vram(n[1], S3KZone)})
	}
	jobs = append(jobs, &job{name: "ZONE", frame: mp[3], v: vram("", S3KZone)})

	for _, j := range jobs {
		ps := make([]piece, len(j.frame))
		for i, p := range j.frame {
			ps[i] = piece{p, xOf(p), wOf(p)}
		}
		sort.SliceStable(ps, func(a, b int) bool { return ps[a].x < ps[b].x })
		for _, q := range ps {
			if (q.p[1]&3+1)*8 != H {
				panic(j.name + ": a piece is not 24px tall")
			}
		}
		for _, q := range ps {
			if n := len(j.words); n > 0 {
				w := j.words[n-1]
				if last := w[len(w)-1]; q.x == last.x+last.w {
					j.words[n-1] = append(w, q)
					continue
				}
			}
			j.words = append(j.words, []piece{q})
		}
		j.letters = strings.Split(j.name, " ")
		if len(j.words) != len(j.letters) {
			panic(fmt.Sprintf("%s: %d runs of pieces for %d words", j.name, len(j.words), len(j.letters)))
		}
	}
	width := map[byte]int{}
	for _, j := range jobs {
		for i, ps := range j.words {
			if len(ps) != len(j.letters[i]) {
				continue
			}
			for k, q := range ps {
				L := j.letters[i][k]
				if width[L] != 0 && width[L] != q.w {
					panic(fmt.Sprintf("%c is %dpx in one name and %dpx in another", L, width[L], q.w))
				}
				width[L] = q.w
			}
		}
	}
	glyphs := map[string]glyph{}
	for _, j := range jobs {
		for i, ps := range j.words {
			word, total := j.letters[i], 0
			for _, q := range ps {
				total += q.w
			}
			sum := 0
			for k := 0; k < len(word); k++ {
				if width[word[k]] == 0 {
					panic(fmt.Sprintf("%s: no width for %c", j.name, word[k]))
				}
				sum += width[word[k]]
			}
			if sum != total {
				panic(fmt.Sprintf("%s: %s does not fill its pieces", j.name, word))
			}
			frame := make(lib.Frame, len(ps))
			for k, q := range ps {
				frame[k] = q.p
			}
			r := lib.RenderFrame(frame, j.v, lib.RenderOpts{})
			x := 0
			for k := 0; k < len(word); k++ {
				L := word[k : k+1]
				w := width[word[k]]
				px := make([]byte, w*H)
				for y := 0; y < H; y++ {
					for k := 0; k < w; k++ {
						px[y*w+k] = r.Px[y*r.W+x+k] & 15
					}
				}
				g, ok := glyphs[L]
				if ok && !bytes.Equal(g.px, px) {
					panic(fmt.Sprintf("%s differs between %s and %s", L, g.from, j.name))
				}
				if !ok {
					glyphs[L] = glyph{w, px, j.name}
				}
				x += w
			}
		}
	}
	fmt.Printf("  %d letters from %d names\n", len(glyphs), len(jobs))

	{
		check := overlay(blank(8), strokeCov(8, 1.95, 7.95))
		real := toMask(glyphs["V"])
		for y, r := range check {
			if r != maskOnly(real[y][:8]) {
				panic("the stroke rule no longer reproduces V")
			}
		}
	}
	// W is M upside down: M is two peaks, W two valleys. The bar stays where it is.
	glyphs["W"] = fromMask(reversed(toMask(glyphs["M"])), "M, flipped")
	// J is U without its left stem above the hook.
	{
		u := toMask(glyphs["U"])
		for y, r := range u {
			if y < 18 {
				u[y] = "." + strings.Repeat(".", 2) + r[3:]
			}
		}
		glyphs["J"] = fromMask(u, "U, left stem cut")
	}
	// X is V's two strokes run corner to corner, crossing at mid-height.
	glyphs["X"] = fromMask(overlay(blank(16),
		strokeCov(16, 1.95, 11.05), strokeCov(16, 11.05, 1.95)), "drawn")
	// Q is O with a short tail through its lower right, at V's stroke weight.
	glyphs["Q"] = fromMask(overlay(toMask(glyphs["O"]), strokeCovY(24, 13.5, 19.5, 15, 24)), "O + tail")

	{
		ring, real := arc(12, 12, 11.25, 11.5, 0, 360), toMask(glyphs["O"])
		drawn := toMask(shape(24, ring))
		off := 0
		for y := 0; y < H; y++ {
			rr := maskOnly(real[y])
			for x := 0; x < 24; x++ {
				if drawn[y][x] != rr[x] {
					off++
				}
			}
		}
		if off > 36 {
			panic(fmt.Sprintf("the arc rule has drifted from O: %d pixels", off))
		}
	}
	// The style keeps its features small and high -- B's upper bowl, A's bar at row 7 --
	// with long strokes below, so & is a small loop on top, a tall bowl, and a leg out
	// to the bottom right: one crossing, where the leg leaves the bowl.
	glyphs["&"] = shape(16, arc(5.6, 4.0, 3.0, 3.6, 0, 360), seg(6.9, 7.4, 13.6, 23.4),
		arc(5.6, 16.6, 4.4, 6.4, 330, 215), seg(3.6, 7.2, 2.0, 11.0))
	glyphs["."] = shape(4, box(1, 22, 3, 24))
	glyphs[","] = shape(5, box(1, 20, 3, 22), seg(2.5, 21.5, 1.2, 23.6))
	glyphs["'"] = shape(4, box(1, 0, 3, 6))
	glyphs[`"`] = shape(7, box(1, 0, 3, 6), box(4, 0, 6, 6))
	glyphs["!"] = shape(4, box(1, 0, 3, 18), box(1, 22, 3, 24))
	glyphs[":"] = shape(4, box(1, 9, 3, 11), box(1, 22, 3, 24))
	glyphs["-"] = shape(10, box(1, 13, 9, 15))
	glyphs["?"] = shape(14, arc(6.2, 5.2, 4.6, 4.6, 180, 100), box(5.2, 10, 7.2, 18), box(5.2, 22, 7.2, 24))

	// ---- digits ------------------------------------------------------------------------------
	// The act number is its own big graphic, so 0-9 are drawn too, borrowing the letters'
	// parts where a digit has one: 3 is B without its stem, 2 and 7 take Z's bars and
	// diagonal, 8 stacks &'s small loop over a tall one, and 9 is 6 turned round.
	glyphs["0"] = shape(14, arc(6.5, 12, 5.3, 11.6, 0, 360))
	glyphs["1"] = shape(10, box(5, 0, 7, 24), seg(2.2, 3.4, 5.6, 0.8))
	glyphs["2"] = shape(14, arc(6.4, 4.6, 4.6, 4.2, 180, 55), seg(9.2, 8.0, 1.9, 22.4), box(1, 22, 12, 24))
	{
		b := toMask(glyphs["B"])
		for y, r := range b {
			b[y] = "." + r[3:]
		}
		glyphs["3"] = fromMask(b, "B, stem cut")
	}
	glyphs["4"] = shape(14, box(9, 0, 11, 24), seg(9.6, 1.0, 1.9, 13.6), box(1, 13, 13, 15))
	glyphs["5"] = shape(14, box(1, 0, 11, 2), box(1, 0, 3, 8.4), arc(6.2, 15.6, 5.4, 7.4, 205, 140))
	glyphs["6"] = shape(14, arc(6.6, 16.2, 5.3, 7.2, 0, 360), arc(11.4, 16.2, 10.1, 15.6, 180, 268))
	glyphs["7"] = shape(14, box(1, 0, 12, 2), seg(11.0, 1.6, 4.2, 23.4))
	glyphs["8"] = shape(14, arc(6.5, 4.2, 3.6, 3.9, 0, 360), arc(6.5, 15.8, 5.3, 7.4, 0, 360))
	{
		six := reversed(toMask(glyphs["6"]))
		for y, r := range six {
			b := []byte(r)
			for l, rr := 0, len(b)-1; l < rr; l, rr = l+1, rr-1 {
				b[l], b[rr] = b[rr], b[l]
			}
			six[y] = string(b)
		}
		glyphs["9"] = fromMask(six, "6, turned")
	}

	// ---- write ------------------------------------------------------------------------
	var order []string
	for L := range glyphs {
		order = append(order, L)
	}
	sort.Strings(order) // single ASCII characters, so a plain byte sort
	AW := 0
	for _, L := range order {
		AW += glyphs[L].w + 2
	}
	atlas := make([]byte, AW*H)
	tblGlyphs := &lib.Obj{}
	table := lib.O("rowh", H, "glyphs", tblGlyphs)
	x := 0
	for _, L := range order {
		g := glyphs[L]
		for y := 0; y < H; y++ {
			copy(atlas[y*AW+x:], g.px[y*g.w:(y+1)*g.w])
		}
		tblGlyphs.Set(L, []int{x, 0, g.w, H, 0})
		x += g.w + 2
	}
	// The title card is drawn in palette line 0 -- Pal_SonicTails, Sonic's line.
	SONIC := []int{0x000, 0xEEE, 0xE66, 0xC42, 0x822, 0x080, 0x00E, 0x008, 0x0AE, 0x08E, 0x8AE, 0x46A, 0xECC, 0xCAA, 0x866, 0x222}
	pal := make([][3]byte, len(SONIC))
	for i, w := range SONIC {
		pal[i] = lib.RGB(w)
	}
	png := lib.EncodeIndexedPNG(atlas, AW, H, pal, 0)
	lib.WriteFile(out, "card-atlas.png", png)
	fmt.Printf("card-atlas.png  %dx%d  %dB  %d glyphs\n", AW, H, len(png), len(order))

	// ---- the rest of the card -----------------------------------------------------------
	// The red banner (frame 1), ZONE (frame 3) and the ACT number (frame 2, over Number 1
	// or Number 2 at $53D), each written as its own image with its offset from the
	// object's origin, so the page can slide them the way their objects move. The
	// banner comes three ways, one per game, by what Obj_TitleCard loads at $510:
	// SONIC 3 (Sonic 3 alone, nothing loaded over Red ACT), SONIC 3 & KNUCKLES, and
	// SONIC & KNUCKLES (ArtKosM_TitleCardSKZone, when SK_alone_flag is set).
	parts := &lib.Obj{}
	table.Set("parts", parts)
	for _, p := range []struct {
		name          string
		frame, number int
		shared        string
	}{
		{"banner-s3", 1, 0, ""}, {"banner-s3k", 1, 0, S3KZone}, {"banner-sk", 1, 0, "TitleCard_SKZone.kosm"},
		{"zone", 3, 0, S3KZone}, {"act1", 2, 1, S3KZone}, {"act2", 2, 2, S3KZone}} {
		v := vram("", p.shared)
		if p.number != 0 {
			copy(v[0x53D*32:], kos(fmt.Sprintf("TitleCard_Number%d.kosm", p.number)))
		}
		r := lib.RenderFrame(mp[p.frame], v, lib.RenderOpts{})
		for i := range r.Px {
			r.Px[i] &= 15
		}
		lib.WriteFile(out, "card-"+p.name+".png", lib.EncodeIndexedPNG(r.Px, r.W, r.H, pal, 0))
		parts.Set(p.name, lib.O("ox", r.Ox, "oy", r.Oy, "w", r.W, "h", r.H))
		fmt.Printf("%-16s %3dx%d  @%d,%d\n", "card-"+p.name+".png", r.W, r.H, r.Ox, r.Oy)
	}
	// ObjArray_TtlCard: where each element starts and rests (screen coordinates, the
	// $80 sprite origin already taken off), and its place in the exit order -- the
	// element leaves once the card's exit counter reaches it. The name's art is ours:
	// every zone-name frame ends at x +128 from its origin, so names right-align there.
	table.Set("card", lib.O(
		"banner", lib.O("x", 0xE0-0x80, "from", 0x10-0x80, "to", 0xC0-0x80, "order", 1), // slides down
		"name", lib.O("y", 0xE0-0x80, "from", 0x260-0x80, "to", 0x120-0x80, "order", 3, "right", 128),
		"zone", lib.O("y", 0x100-0x80, "from", 0x2FC-0x80, "to", 0x17C-0x80, "order", 5),
		"act", lib.O("y", 0x120-0x80, "from", 0x344-0x80, "to", 0x184-0x80, "order", 7),
		"speedIn", 0x10, "speedOut", 0x20, "hold", 90, // Obj_TitleCardElement, $2E
	))
	lib.WriteFile(out, "card-table.json", []byte(lib.Stringify(table)))
	for _, L := range []string{"J", "Q", "W", "X"} {
		fmt.Printf("  %s: %s\n", L, glyphs[L].from)
	}
	fmt.Println(`  drawn: & . , ' " ! ? : - and 0-9`)
}
