package lib

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"testing"
)

// CheckStep runs the JS build step (tools/<script>) and the Go one into two fresh
// directories and requires the same files with the same bytes. Each step's test
// is this, so a step is done when its output cannot be told from the JS's.
func CheckStep(t *testing.T, script string, build func(out string)) {
	t.Helper()
	js, gd := t.TempDir(), t.TempDir()
	cmd := exec.Command("node", filepath.Join(Tools(), script), js)
	cmd.Dir = Root()
	if outp, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("node %s: %v\n%s", script, err, outp)
	}
	build(gd)
	list := func(d string) []string {
		es, _ := os.ReadDir(d)
		var n []string
		for _, e := range es {
			n = append(n, e.Name())
		}
		sort.Strings(n)
		return n
	}
	a, b := list(js), list(gd)
	if len(a) == 0 {
		t.Fatal("the JS step wrote nothing")
	}
	inJS := map[string]bool{}
	for _, f := range a {
		inJS[f] = true
	}
	same := 0
	for _, f := range b {
		if !inJS[f] {
			t.Errorf("Go wrote %s, the JS did not", f)
		}
	}
	for _, f := range a {
		x, _ := os.ReadFile(filepath.Join(js, f))
		y, err := os.ReadFile(filepath.Join(gd, f))
		if err != nil {
			t.Errorf("Go did not write %s", f)
			continue
		}
		if !bytes.Equal(x, y) {
			at := 0
			for at < len(x) && at < len(y) && x[at] == y[at] {
				at++
			}
			t.Errorf("%s differs: %d bytes vs JS %d, first at byte %d", f, len(y), len(x), at)
			continue
		}
		same++
	}
	t.Logf("%s: %d of %d files byte-identical", script, same, len(a))
}
