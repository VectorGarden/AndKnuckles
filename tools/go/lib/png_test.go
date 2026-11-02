package lib

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// Every PNG the JS pipeline wrote, decoded and re-encoded here, must come out
// byte for byte the same: the Go deflate and PNG writer against the JS ones.
func TestEncodeMatchesJS(t *testing.T) {
	files, _ := filepath.Glob("../../out/*.png")
	if len(files) == 0 {
		t.Skip("no tools/out: run node tools/build-all.mjs first")
	}
	for _, f := range files {
		b, _ := os.ReadFile(f)
		p, err := DecodePNG(b)
		if err != nil {
			t.Fatal(f, err)
		}
		pal := make([][3]byte, len(p.Plte)/3)
		for i := range pal {
			pal[i] = [3]byte{p.Plte[i*3], p.Plte[i*3+1], p.Plte[i*3+2]}
		}
		tr := -1
		if p.Trns != nil {
			tr = len(p.Trns) - 1
		}
		if got := EncodeIndexedPNG(p.Data, p.W, p.H, pal, tr); !bytes.Equal(got, b) {
			t.Errorf("%s: %d bytes, JS wrote %d", filepath.Base(f), len(got), len(b))
		}
	}
	t.Logf("%d PNGs identical", len(files))
}
