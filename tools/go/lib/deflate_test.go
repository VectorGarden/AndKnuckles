package lib

import (
	"bytes"
	"compress/zlib"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Deflate against the system's stock zlib, through Python's zlib module: level
// 9, whole buffer, byte for byte. The inputs are the raw image data of every PNG
// the page carries, and a few that exercise the corners -- empty, one byte,
// runs, incompressible noise, text, and more than two windows so the window
// slides.
func deflateInputs(t *testing.T) (names []string, raws [][]byte) {
	seed := uint32(7)
	rnd := func() byte { seed = seed*1103515245 + 12345; return byte(seed >> 24) }
	add := func(n string, b []byte) { names = append(names, n); raws = append(raws, b) }
	add("empty", []byte{})
	add("one byte", []byte{42})
	add("zeros", make([]byte, 100000))
	noise := make([]byte, 70000)
	for i := range noise {
		noise[i] = rnd()
	}
	add("noise", noise)
	add("text", Must(os.ReadFile(filepath.Join(Root(), "README.md"))))
	mix := make([]byte, 200000)
	for i := range mix {
		if i%977 < 500 {
			mix[i] = rnd() & 7
		} else if i >= 977 {
			mix[i] = mix[i-977]
		}
	}
	add("mixed", mix)
	for i, b := range PagePNGs() {
		var idat []byte
		for p := 8; p < len(b); {
			n := int(b[p])<<24 | int(b[p+1])<<16 | int(b[p+2])<<8 | int(b[p+3])
			if string(b[p+4:p+8]) == "IDAT" {
				idat = append(idat, b[p+8:p+8+n]...)
			}
			p += 12 + n
		}
		r, err := zlib.NewReader(bytes.NewReader(idat))
		if err != nil {
			t.Fatal(err)
		}
		add(fmt.Sprintf("page PNG %d", i), Must(io.ReadAll(r)))
	}
	return
}

func TestDeflateIsStockZlib(t *testing.T) {
	if exec.Command("python3", "-c", "import zlib").Run() != nil {
		t.Skip("no python3 to run the system zlib")
	}
	names, raws := deflateInputs(t)
	dir := t.TempDir()
	for i, b := range raws {
		os.WriteFile(filepath.Join(dir, fmt.Sprintf("%d.raw", i)), b, 0o644)
	}
	if outp, err := exec.Command("python3", "-c", `
import sys, zlib, glob
for f in glob.glob(sys.argv[1] + '/*.raw'):
    open(f[:-4] + '.z', 'wb').write(zlib.compress(open(f, 'rb').read(), 9))`, dir).CombinedOutput(); err != nil {
		t.Fatalf("python3: %v\n%s", err, outp)
	}
	bad := 0
	for i, b := range raws {
		want := Must(os.ReadFile(filepath.Join(dir, fmt.Sprintf("%d.z", i))))
		if got := Deflate(b); !bytes.Equal(got, want) {
			bad++
			t.Errorf("%s: %d bytes, zlib %d", names[i], len(got), len(want))
		}
	}
	if len(raws) < 150 {
		t.Fatalf("only %d inputs", len(raws))
	}
	t.Logf("%d inputs, %d differ from zlib", len(raws), bad)
}

func TestDeflateInflatesBack(t *testing.T) {
	names, raws := deflateInputs(t)
	for i, b := range raws[:12] {
		r, err := zlib.NewReader(bytes.NewReader(Deflate(b)))
		if err != nil {
			t.Fatal(names[i], err)
		}
		if got := Must(io.ReadAll(r)); !bytes.Equal(got, b) {
			t.Errorf("%s does not inflate back", names[i])
		}
	}
}
