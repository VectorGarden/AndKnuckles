package s2

import (
	"fmt"
	"slices"
	"strings"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// reverseRows turns a glyph round: its rows bottom to top, each right to left.
func reverseRows(rows []string) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		b := []byte(r)
		slices.Reverse(b)
		out[len(rows)-1-i] = string(b)
	}
	return out
}

// ---- the lettering -----------------------------------------------------------------------------------
// The credit font: the face of SONIC AND MILES 'TAILS' PROWER IN, the screen before the title, and
// of the staff roll. A white outline round a hollow letter, one tile tall and two wide: creditText
// writes each letter as its upper-case code then its lower-case one, through the charset s2.asm sets
// up for the intro text (tiles from $500). I's right half is the 1's. Single-tile marks are 8 wide.
func buildLettering(out string) {
	credArt := lib.NemDecode(rd("S2_CreditText.nem"))
	UPPER := []int{1, 3, 5, 7, 9, 0xB, 0xD, 0xF, 0x11, 0x12, 0x14, 0x16, 0x18, 0x1A, 0x1C, 0x1E, 0x20, 0x22, 0x24, 0x26, 0x28, 0x2A, 0x2C, 0x2E, 0x30, 0x32}
	LOWER := []int{2, 4, 6, 8, 0xA, 0xC, 0xE, 0x10, 0x11, 0x13, 0x15, 0x17, 0x19, 0x1B, 0x1D, 0x1F, 0x21, 0x23, 0x25, 0x27, 0x29, 0x2B, 0x2D, 0x2F, 0x31, 0x33}
	TILES := map[string][]int{}
	for i := 0; i < 26; i++ {
		TILES[string(rune(65+i))] = []int{UPPER[i], LOWER[i]}
	}
	for c, ts := range map[string][]int{"I": {0x11, 0x3C}, "1": {0x3B, 0x3C}, "2": {0x34, 0x35}, "9": {0x3D, 0x3E},
		"(": {0x36}, ")": {0x37}, "'": {0x38}, ".": {0x39}, ":": {0x3F}} {
		TILES[c] = ts
	}
	rowsOf := func(ts []int) []string {
		rows := make([]string, 8)
		for y := range rows {
			var b strings.Builder
			for _, t := range ts {
				for x := 0; x < 8; x++ {
					v := credArt[t*32+y*4+(x>>1)]
					c := v >> 4
					if x&1 != 0 {
						c = v & 15
					}
					if c != 0 {
						b.WriteByte('#')
					} else {
						b.WriteByte('.')
					}
				}
			}
			rows[y] = b.String()
		}
		return rows
	}
	// The atlas is laid out in sorted key order, so only which glyphs there are matters here.
	type cglyph struct {
		rows []string
		from string
	}
	cglyphs := map[string]cglyph{}
	for c, ts := range TILES {
		cglyphs[c] = cglyph{rowsOf(ts), "credits"}
	}
	// The intro and the roll never spell Q, but the art has it; they never use the other digits or
	// these marks, which are drawn here in the face's own way -- the digits on 2's and 9's outlines,
	// 0 is O, 6 is 9 turned round.
	drawn := map[string][]string{
		"3": {"..###########...", ".##.........##..", ".########....#..", "........#...#...", ".########....#..", ".#...........#..", ".##.........##..", "..###########..."},
		"4": {".######.######..", ".#....#.#....#..", ".#....###....#..", ".#...........#..", ".########....#..", "........#....#..", "........#....#..", "........######.."},
		"5": {".#############..", ".#...........#..", ".#....########..", ".#..........##..", ".########....#..", ".########....#..", ".#..........##..", ".############..."},
		"7": {".#############..", ".#...........#..", ".#######....#...", "......#....#....", ".....#....#.....", "....#....#......", "....#....#......", "....######......"},
		"8": {"..###########...", ".##.........##..", ".#....###....#..", "..#.........#...", ".#....###....#..", ".#....###....#..", ".##.........##..", "..###########..."},
		"!": {"..####..", "..#..#..", "..#..#..", "..#..#..", "..####..", "........", "..####..", "..####.."},
		"-": {"........", "........", ".######.", ".#....#.", ".######.", "........", "........", "........"},
		",": {"........", "........", "........", "........", "..####..", "..#..#..", "..####..", "..##...."},
		"?": {"...########.....", "..##......##....", "..#####....#....", "......#...##....", "......#####.....", "................", "......####......", "......####......"},
		"&": {"...######.......", "..##....##......", "..##....##......", "...##..##..##...", "..##.##..####...", ".##...##..##....", ".##....##..##...", "..######..####.."},
	}
	drawn["0"] = cglyphs["O"].rows
	six := reverseRows(cglyphs["9"].rows)
	for i, r := range six {
		six[i] = r[1:] + "."
	}
	drawn["6"] = six
	for c, rows := range drawn {
		cglyphs[c] = cglyph{rows, "drawn"}
	}
	for _, r := range cglyphs["6"].rows {
		if len(r) != 16 {
			panic("6 is not 16 wide")
		}
	}

	corder := make([]string, 0, len(cglyphs))
	for c := range cglyphs {
		corder = append(corder, c)
	}
	slices.Sort(corder)
	CW := 0
	for _, c := range corder {
		CW += len(cglyphs[c].rows[0]) + 2
	}
	catlas := make([]byte, CW*8)
	glyphs := &lib.Obj{}
	ctable := lib.O("rowh", 8, "glyphs", glyphs)
	cx, ndrawn := 0, ""
	for _, c := range corder {
		r := cglyphs[c].rows
		w := len(r[0])
		for y, row := range r {
			for x := 0; x < len(row); x++ {
				if row[x] == '#' {
					catlas[y*CW+cx+x] = 6
				}
			}
		}
		glyphs.Set(c, []int{cx, 0, w, 8, 0})
		cx += w + 2
		if cglyphs[c].from == "drawn" {
			ndrawn += c
		}
	}
	// Pal_BGND's line 0, which the intro text is drawn in: colour 6 is the white
	credPal := colours(lib.Words(rd("S2_Pal_SonicAndTails.bin")))
	lib.WriteFile(out, "s2cred-atlas.png", lib.EncodeIndexedPNG(catlas, CW, 8, credPal, 0))
	lib.WriteFile(out, "s2cred-table.json", []byte(lib.Stringify(ctable)))
	fmt.Printf("s2cred-atlas.png %dx8  %d glyphs (%s drawn)\n", CW, len(corder), ndrawn)
}
