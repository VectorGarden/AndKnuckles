package lib

import (
	"bufio"
	"math"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// Node computes Math.hypot, atan2, sin and cos over inputs like the shapes'
// (and plenty of random ones). On x86-64 every result must match ours to the bit.
// On arm64 V8 itself is compiled with fused multiply-adds (clang's default), so
// there it may differ from x86-64 V8, and from us, by one unit in the last place.
func TestMathMatchesV8(t *testing.T) {
	script := `
let s = 1; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
const out = [];
for(let i = 0; i < 200000; i++){
  const a = (r() - 0.5) * 80, b = (r() - 0.5) * 80;
  const ha = Math.round(a * 2) / 2, hb = Math.round(b * 2) / 2;   // half-pixel samples, as the shapes take
  for(const [y, x] of [[a, b], [ha, hb], [ha, ha], [hb, -hb]]){
    const t = Math.atan2(y, x);
    out.push([y, x, Math.hypot(y, x), t, Math.sin(t), Math.cos(t)].map(v => Object.is(v, -0) ? '-0' : v.toString()).join(' '));
  }
}
console.log(out.join('\n'));`
	cmd := exec.Command("node", "-e", script)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Skip(err)
	}
	if err := cmd.Start(); err != nil {
		t.Skip("no node:", err)
	}
	sc := bufio.NewScanner(stdout)
	bad, n := 0, 0
	f := func(s string) float64 { v, _ := strconv.ParseFloat(s, 64); return v }
	for sc.Scan() {
		p := strings.Fields(sc.Text())
		y, x := f(p[0]), f(p[1])
		th := Atan2(y, x)
		tv := f(p[3]) // V8's own angle, so sin and cos are tested on their own
		got := []float64{Hypot(y, x), th, Sin(tv), Cos(tv)}
		for i, g := range got {
			want := f(p[2+i])
			d := int64(math.Float64bits(g)) - int64(math.Float64bits(want))
			if d < 0 {
				d = -d
			}
			if d > 1 || (d == 1 && runtime.GOARCH == "amd64") {
				if bad < 5 {
					t.Errorf("fn %d of (%v, %v): %v, V8 %s", i, y, x, g, p[2+i])
				}
				bad++
			}
		}
		n++
	}
	cmd.Wait()
	if bad > 0 {
		t.Fatalf("%d mismatches over %d inputs", bad, n)
	}
	t.Logf("%d inputs on %s, all four functions match V8", n, runtime.GOARCH)
	_ = os.Stdout
}
