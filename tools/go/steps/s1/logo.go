package s1

import (
	"fmt"
	"slices"
	"strings"

	"github.com/VectorGarden/AndKnuckles/tools/go/fonts"
	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// ---- the logo, cleared and turned into faces --------------------------------------------------
// The S1 logo style replaces SONIC and THE HEDGEHOG with the user's text, so the build
// needs the emblem without them, and their two faces.
//
// Clearing: the ribbon behind the letters is a flag -- red, a white stripe on rows 86-100,
// red -- read off the gap between I and C, which is pure ribbon. Between x 59 and 196 the
// letters cover nothing else, so rows 76-115 are refilled from that pattern. Either side,
// S and C touch the ribbon's star-field ends, which are mirror images of each other about
// x 127.5 and the letters are not: rows above 89 have no star field, so those are refilled
// too; below, a pixel that matches its mirror is star field, black is always letter, and
// one side showing ribbon where the other does not is letter over ribbon.
func buildLogo(out string, emblem []byte) {
	const EWD = EW * 8
	ribbon := func(y int) byte {
		if y >= 86 && y <= 100 {
			return 6
		}
		return 12
	}
	clean := slices.Clone(emblem)
	MIR := func(x int) int { return 255 - x }
	for y := 76; y <= 115; y++ {
		for x := 59; x <= 196; x++ {
			clean[y*EWD+x] = ribbon(y)
		}
		for x := 52; x <= 58; x++ {
			a, b, rb := emblem[y*EWD+x], emblem[y*EWD+MIR(x)], ribbon(y)
			if y < 89 {
				clean[y*EWD+x], clean[y*EWD+MIR(x)] = rb, rb
				continue
			}
			if a == b && a&15 != 15 {
				continue
			}
			if a&15 == 15 || b == rb {
				clean[y*EWD+x] = rb
			}
			if b&15 == 15 || a == rb {
				clean[y*EWD+MIR(x)] = rb
			}
			if a != b && a != rb && b != rb && a&15 != 15 && b&15 != 15 {
				clean[y*EWD+x], clean[y*EWD+MIR(x)] = rb, rb
			}
		}
	}
	lib.WriteIdx(out, "s1-emblem-clean.png", clean, EWD, EH*8)

	// The chrome face. S O N I C are lifted as shapes: their fill colours (the blues and
	// golds), plus white with fill above it in the column -- the band through the middle and
	// the rim along the bottom -- leaving out the white caps and the black. Stray pixels of
	// the star field that share the fill colours are kept out by column and row.
	logoFont := fonts.LoadS1Logo()
	FILL := map[int]bool{3: true, 4: true, 5: true, 11: true, 9: true, 8: true, 7: true}
	LIFT := []struct {
		k    string
		a, b int
	}{{"S", 56, 84}, {"O", 84, 117}, {"N", 117, 150}, {"I", 154, 169}, {"C", 169, 199}}
	shapes := logoFont.Designs.Clone()
	for _, l := range LIFT {
		// m is a JS Set: its order matters, since specks are dropped one by one
		var order []int
		m := map[int]bool{}
		add := func(v int) { order, m[v] = append(order, v), true }
		for x := l.a; x < l.b; x++ {
			f := false
			for y := 76; y <= 103; y++ {
				if (x < 59 || x > 196) && y >= 89 {
					continue
				}
				v := int(emblem[y*EWD+x]) & 15
				if FILL[v] {
					f = true
					add(x*1000 + y)
				} else if v == 6 && f {
					add(x*1000 + y)
				} else if v == 15 {
					f = false
				}
			}
		}
		// drop specks: pixels with fewer than two of their four neighbours in the shape
		for _, v := range order {
			x, y := v/1000, v%1000
			n := 0
			for _, d := range [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
				if m[(x+d[0])*1000+y+d[1]] {
					n++
				}
			}
			if n < 2 {
				delete(m, v)
			}
		}
		x0, x1 := 1<<30, -(1 << 30)
		for _, v := range order {
			if m[v] {
				x0, x1 = min(x0, v/1000), max(x1, v/1000)
			}
		}
		rows := make([]string, 26)
		for i := range rows {
			b := make([]byte, x1-x0+1)
			for j := range b {
				b[j] = '.'
				if m[(x0+j)*1000+77+i] {
					b[j] = '#'
				}
			}
			rows[i] = string(b)
		}
		shapes.Set(l.k, rows)
	}
	for _, c := range strings.Split("SONIC", "") {
		if strings.Join(shapes.Get(c).([]string), ",") != strings.Join(logoFont.Sonic.Get(c).([]string), ",") {
			panic(fmt.Sprintf("the lifted %s is not font/s1-logo.mjs's", c))
		}
	}
	// the fill by row, read down the I, which is straight-sided top to bottom
	gradient := make([]int, 26)
	for i := range gradient {
		gradient[i] = int(emblem[(77+i)*EWD+160]) & 15
	}
	// The small face: T H E D G O lifted from rows 108-113 (white), the rest designed.
	small := logoFont.Small.Clone()
	words := []string{"T", "H", "E", "", "H", "E", "D", "G", "E", "H", "O", "G"} // "" is the JS null
	white := func(col int) bool {
		for i := 0; i < 6; i++ {
			if at(emblem, (108+i)*EWD+col)&15 == 6 {
				return true
			}
		}
		return false
	}
	col, k := 86, 0
	for col < 170 && k < len(words) {
		for col < 170 && !white(col) {
			col++
		}
		s := col
		for white(col) {
			col++
		}
		if words[k] == "" {
			k++
		}
		ch := ""
		if k < len(words) {
			ch = words[k]
		}
		k++
		if ch != "" && !small.Has(ch) {
			rows := make([]string, 6)
			for i := range rows {
				b := make([]byte, col-s)
				for j := range b {
					b[j] = '.'
					if at(emblem, (108+i)*EWD+s+j)&15 == 6 {
						b[j] = '#'
					}
				}
				rows[i] = string(b)
			}
			small.Set(ch, rows)
		}
	}
	for _, c := range strings.Split("THEDGO", "") {
		if !small.Has(c) {
			panic("small " + c + " was not lifted")
		}
	}
	// Placement, in screen coordinates (the emblem sits at 24, 32): SONIC's shapes start on
	// emblem row 77, THE HEDGEHOG's on 108; both centred on the emblem's middle, x 127.5.
	logo := lib.O("chrome", shapes, "gradient", gradient, "small", small, "top", 77+EY, "smallTop", 108+EY, "cx", 128+EX,
		"gap", 3, "space", 12, "smallGap", 1, "smallSpace", 7, "depth", 3, "spread", 16, "lean", 3)
	lib.WriteFile(out, "s1-logo.json", []byte(lib.Stringify(logo)))
	fmt.Printf("  logo: %d chrome shapes (SONIC lifted), %d small\n", len(*shapes), len(*small))
}
