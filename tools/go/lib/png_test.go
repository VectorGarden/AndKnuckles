package lib

import (
	"bytes"
	"testing"
)

// Every PNG the committed page carries, decoded and re-encoded here, must come
// out byte for byte the same: the PNG writer and the deflate, together.
func TestEncodeRoundTripsThePage(t *testing.T) {
	pngs := PagePNGs()
	if len(pngs) < 100 {
		t.Fatalf("only %d PNGs found in the page", len(pngs))
	}
	for i, b := range pngs {
		p, err := DecodePNG(b)
		if err != nil {
			t.Fatal(i, err)
		}
		pal := make([][3]byte, len(p.Plte)/3)
		for k := range pal {
			pal[k] = [3]byte{p.Plte[k*3], p.Plte[k*3+1], p.Plte[k*3+2]}
		}
		tr := -1
		if p.Trns != nil {
			tr = len(p.Trns) - 1
		}
		if got := EncodeIndexedPNG(p.Data, p.W, p.H, pal, tr); !bytes.Equal(got, b) {
			t.Errorf("PNG %d (%dx%d): %d bytes, the page has %d", i, p.W, p.H, len(got), len(b))
		}
	}
	t.Logf("%d PNGs re-encode to the page's bytes", len(pngs))
}
