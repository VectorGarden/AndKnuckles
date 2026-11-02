package lib

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// CheckStep builds a step into a fresh directory and requires every PNG it
// writes to be one the committed page carries, byte for byte, in
// src/generated/assets.js -- so a step whose output drifts from the page fails
// its own test, by name. reference names the outputs that are written for
// reference only and never embedded. The JSON a step writes is reshaped by the
// embed on its way into the page, so it is held to it by the full pipeline's
// --check instead.
func CheckStep(t *testing.T, build func(out string), reference ...string) {
	t.Helper()
	out := t.TempDir()
	build(out)
	page := string(Must(os.ReadFile(filepath.Join(Root(), "src", "generated", "assets.js"))))
	ref := map[string]bool{}
	for _, f := range reference {
		ref[f] = true
	}
	es, _ := os.ReadDir(out)
	var names []string
	for _, e := range es {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	pngs, carried := 0, 0
	for _, f := range names {
		if !strings.HasSuffix(f, ".png") {
			continue
		}
		pngs++
		if ref[f] {
			delete(ref, f)
			continue
		}
		b64 := base64.StdEncoding.EncodeToString(Must(os.ReadFile(filepath.Join(out, f))))
		if !strings.Contains(page, `"data:image/png;base64,`+b64+`"`) {
			t.Errorf("%s is not the PNG the committed page carries", f)
			continue
		}
		carried++
	}
	for f := range ref {
		t.Errorf("%s, written for reference, was not written", f)
	}
	if pngs == 0 {
		t.Fatal("the step wrote no PNGs")
	}
	t.Logf("%d of %d PNGs are the committed page's, byte for byte", carried, pngs-len(reference))
}

// PagePNGs is every PNG the committed page carries, decoded from its data URIs.
func PagePNGs() [][]byte {
	page := string(Must(os.ReadFile(filepath.Join(Root(), "src", "generated", "assets.js"))))
	var out [][]byte
	seen := map[string]bool{}
	for _, m := range regexp.MustCompile(`data:image/png;base64,([A-Za-z0-9+/=]+)`).FindAllStringSubmatch(page, -1) {
		if seen[m[1]] {
			continue
		}
		seen[m[1]] = true
		out = append(out, Must(base64.StdEncoding.DecodeString(m[1])))
	}
	return out
}
