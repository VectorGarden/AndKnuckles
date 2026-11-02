// Package fonts reads the shape modules in tools/font for the Go build steps.
package fonts

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// The Sonic 1 logo faces (tools/font/s1-logo.mjs). DESIGNS is written there as
// calls -- inside(width, [box(...), seg(...), ring(...), minus(a, b)]) -- which
// this evaluates the same way, in the same floating point, sample by sample.
// SMALL and SONIC are plain data, read as literals. Each is an Obj of []string
// in the module's key order.

const logoH = 26

type shapeFn func(x, y float64) bool

func box(x0, y0, x1, y1 float64) shapeFn {
	return func(x, y float64) bool { return x >= x0 && x < x1 && y >= y0 && y < y1 }
}

func seg(x0, y0, x1, y1, hw float64) shapeFn {
	return func(x, y float64) bool {
		dx, dy := x1-x0, y1-y0
		// float64(...) rounds each product: Go may otherwise fuse a*b+c, which V8 on x86 never does
		t := math.Max(0, math.Min(1, (float64((x-x0)*dx)+float64((y-y0)*dy))/(float64(dx*dx)+float64(dy*dy))))
		return lib.Hypot(x-(x0+float64(t*dx)), y-(y0+float64(t*dy))) <= hw
	}
}

func ring(cx, cy, rx, ry, tx, ty, a0, a1 float64) shapeFn {
	return func(x, y float64) bool {
		ox, oy := (x-cx)/rx, (y-cy)/ry
		ix, iy := (x-cx)/(rx-tx), (y-cy)/(ry-ty)
		o, i := float64(ox*ox)+float64(oy*oy), float64(ix*ix)+float64(iy*iy)
		if o > 1 || i < 1 {
			return false
		}
		d := lib.Atan2(y-cy, x-cx) * 180 / math.Pi
		if d < 0 {
			d += 360
		}
		if a0 <= a1 {
			return d >= a0 && d <= a1
		}
		return d >= a0 || d <= a1
	}
}

func inside(w int, fns []shapeFn) []string {
	rows := make([]string, logoH)
	for y := 0; y < logoH; y++ {
		var b strings.Builder
		for x := 0; x < w; x++ {
			hit := false
			for _, f := range fns {
				if f(float64(x)+0.5, float64(y)+0.5) {
					hit = true
					break
				}
			}
			if hit {
				b.WriteByte('#')
			} else {
				b.WriteByte('.')
			}
		}
		rows[y] = b.String()
	}
	return rows
}

// a call in the DESIGNS source: name(args), args numbers, calls or [calls]
type call struct {
	name string
	args []any
}

type callParser struct {
	s string
	i int
}

func (p *callParser) ws() {
	for p.i < len(p.s) && strings.ContainsRune(" \t\r\n", rune(p.s[p.i])) {
		p.i++
	}
}

func (p *callParser) arg() any {
	p.ws()
	if p.s[p.i] == '[' {
		p.i++
		var list []any
		for {
			p.ws()
			if p.s[p.i] == ']' {
				p.i++
				return list
			}
			list = append(list, p.arg())
			p.ws()
			if p.s[p.i] == ',' {
				p.i++
			}
		}
	}
	st := p.i
	for p.i < len(p.s) && strings.ContainsRune("0123456789.-", rune(p.s[p.i])) {
		p.i++
	}
	if p.i > st {
		v, err := strconv.ParseFloat(p.s[st:p.i], 64)
		if err != nil {
			panic(err)
		}
		return v
	}
	for p.i < len(p.s) && p.s[p.i] >= 'a' && p.s[p.i] <= 'z' {
		p.i++
	}
	c := call{name: p.s[st:p.i]}
	p.ws()
	p.i++ // (
	for {
		p.ws()
		if p.s[p.i] == ')' {
			p.i++
			return c
		}
		c.args = append(c.args, p.arg())
		p.ws()
		if p.s[p.i] == ',' {
			p.i++
		}
	}
}

func num(a []any, i int, def float64) float64 {
	if i < len(a) {
		return a[i].(float64)
	}
	return def
}

func build(v any) shapeFn {
	c := v.(call)
	a := c.args
	switch c.name {
	case "box":
		return box(num(a, 0, 0), num(a, 1, 0), num(a, 2, 0), num(a, 3, 0))
	case "seg":
		return seg(num(a, 0, 0), num(a, 1, 0), num(a, 2, 0), num(a, 3, 0), num(a, 4, 4.6))
	case "ring":
		return ring(num(a, 0, 0), num(a, 1, 0), num(a, 2, 0), num(a, 3, 0), num(a, 4, 0), num(a, 5, 0), num(a, 6, 0), num(a, 7, 360))
	case "minus":
		f, g := build(a[0]), build(a[1])
		return func(x, y float64) bool { return f(x, y) && !g(x, y) }
	}
	panic("s1-logo: unknown shape " + c.name)
}

// S1Logo is the module's three exports.
type S1Logo struct{ Designs, Small, Sonic *lib.Obj }

// LoadS1Logo reads tools/font/s1-logo.mjs.
func LoadS1Logo() S1Logo {
	src := string(lib.Must(os.ReadFile(filepath.Join(lib.Tools(), "font", "s1-logo.mjs"))))
	body := src[strings.Index(src, "export const DESIGNS = {")+len("export const DESIGNS = {"):]
	body = body[:strings.Index(body, "\n};")]
	designs := &lib.Obj{}
	p := &callParser{s: body}
	for {
		p.ws()
		if p.i >= len(p.s) {
			break
		}
		// key: X, 0, '&' or "'"
		var key string
		if q := p.s[p.i]; q == '\'' || q == '"' {
			end := strings.IndexByte(p.s[p.i+1:], q)
			key = p.s[p.i+1 : p.i+1+end]
			p.i += end + 2
		} else {
			st := p.i
			for p.s[p.i] != ':' {
				p.i++
			}
			key = strings.TrimSpace(p.s[st:p.i])
		}
		p.ws()
		p.i++ // :
		c := p.arg().(call)
		if c.name != "inside" {
			panic("s1-logo: expected inside(), got " + c.name)
		}
		var fns []shapeFn
		for _, f := range c.args[1].([]any) {
			fns = append(fns, build(f))
		}
		designs.Set(key, inside(int(c.args[0].(float64)), fns))
		p.ws()
		if p.i < len(p.s) && p.s[p.i] == ',' {
			p.i++
		}
	}
	// DESIGNS[9] = DESIGNS[6] turned round
	six := designs.Get("6").([]string)
	nine := make([]string, len(six))
	for i, r := range six {
		b := []byte(r)
		for l, rr := 0, len(b)-1; l < rr; l, rr = l+1, rr-1 {
			b[l], b[rr] = b[rr], b[l]
		}
		nine[len(six)-1-i] = string(b)
	}
	designs.Set("9", nine)

	small := &lib.Obj{}
	for _, kv := range *lib.JSLiteral("font/s1-logo.mjs", "SMALL").(*lib.Obj) {
		small.Set(kv.K, strings.Split(kv.V.(string), "/"))
	}
	sonic := &lib.Obj{}
	for _, kv := range *lib.JSLiteral("font/s1-logo.mjs", "SONIC").(*lib.Obj) {
		sonic.Set(kv.K, lib.Strings(kv.V))
	}
	return S1Logo{designs, small, sonic}
}

var _ = fmt.Sprint
