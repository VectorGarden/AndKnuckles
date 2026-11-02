/*
Package s2 builds the Sonic 2 assets: the title screen, the credit font, the
logo, the title card and Emerald Hill Zone.

From sonicretro/s2disasm (REV01, bugs kept -- it is the game people played):

	s2-bg.png        plane B: MapEng_TitleScreen and MapEng_TitleBack side by
	                 side, the 512px plane TitleScreen fills
	s2-emblem.png    plane A: MapEng_TitleLogo, with the copyright line
	s2-spr*.png      Obj0E's mapping frames, as palette-index layers
	s2-still.png     the title at rest, for still mode
	s2-meta.json     palettes, and Obj0E's timeline: every frame's sprites

And the credit font -- SONIC AND MILES 'TAILS' PROWER IN, the staff roll --
as a letter style: s2cred-atlas.png and s2cred-table.json.

Nothing on this screen is a fixed picture. It opens on black with a star
twinkling from place to place, the emblem fades in, Sonic and then Tails rise
out of it, and the background arrives in a white flash. All of that is one
object, Obj0E, plus two palette changers (ObjC9), so the build runs them --
transcribed from s2.asm below -- and writes down what each frame shows. The
page only plays that table back.
*/
package s2

import (
	"fmt"
	"strconv"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

const (
	W, H = 320, 224
	bgW  = 512 // plane B's width
)

var rd = lib.Rom

// Build writes every Sonic 2 file into out.
func Build(out string) {
	out = lib.OutDir(out)
	t := buildTitle(out)
	buildLogo(out, t)
	lib.WriteFile(out, "s2-meta.json", []byte(lib.Stringify(t.meta)))
	buildLettering(out)
	c := buildCard(out)
	buildEHZ(out, t, c)
}

// phex is a palette as the meta files hold it: three hex digits a colour.
func phex(p []int) string {
	s := ""
	for _, c := range p {
		s += fmt.Sprintf("%03x", c)
	}
	return s
}

// hexPalette turns phex's string back into 64 colours, for a still.
func hexPalette(p string) [][3]byte {
	pal := make([][3]byte, 64)
	for i := range pal {
		v, _ := strconv.ParseInt(p[i*3:i*3+3], 16, 64)
		pal[i] = lib.RGB(int(v))
	}
	return pal
}

func colours(ws []int) [][3]byte {
	out := make([][3]byte, len(ws))
	for i, w := range ws {
		out[i] = lib.RGB(w)
	}
	return out
}

// subarray is Uint8Array.subarray: clamped to the buffer.
func subarray(b []byte, s, e int) []byte {
	s, e = min(s, len(b)), min(e, len(b))
	return b[s:e]
}

// uniq is [...new Set(xs)]: first appearances, in order.
func uniq(xs []int) []int {
	seen := map[int]bool{}
	var out []int
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

func anyNonZero(px []byte) bool {
	for _, v := range px {
		if v != 0 {
			return true
		}
	}
	return false
}
