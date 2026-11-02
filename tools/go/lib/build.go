package lib

import (
	"fmt"
	"os"
	"path/filepath"
)

// The helpers every build step shares, as each tools/build-*.mjs defines them.

// Root is the repository root: the nearest directory up from here holding tools/rom.
func Root() string {
	dir, _ := os.Getwd()
	for d := dir; ; d = filepath.Dir(d) {
		if st, err := os.Stat(filepath.Join(d, "tools", "rom")); err == nil && st.IsDir() {
			return d
		}
		if filepath.Dir(d) == d {
			panic("tools/rom not found above " + dir)
		}
	}
}

// Tools is the tools directory.
func Tools() string { return filepath.Join(Root(), "tools") }

// OutDir is where a step writes: its argument if given, else tools/out. It is created.
func OutDir(arg string) string {
	out := filepath.Join(Tools(), "out")
	if arg != "" {
		out, _ = filepath.Abs(arg)
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		panic(err)
	}
	return out
}

// Rom reads a file from tools/rom.
func Rom(name string) []byte { return Must(os.ReadFile(filepath.Join(Tools(), "rom", name))) }

// Must panics on an error, as a build script throws.
func Must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// Words reads big-endian 16-bit words.
func Words(b []byte) []int {
	w := make([]int, len(b)/2)
	for i := range w {
		w[i] = int(b[i*2])<<8 | int(b[i*2+1])
	}
	return w
}

// RGB is a Genesis colour word as 8-bit channels, 36 a step.
func RGB(w int) [3]byte { return [3]byte{byte(((w >> 1) & 7) * 36), byte(((w >> 5) & 7) * 36), byte(((w >> 9) & 7) * 36)} }

// Key is the grey ramp palette-index layers are written in: index g as g*4.
var Key = func() [][3]byte {
	k := make([][3]byte, 64)
	for g := range k {
		k[g] = [3]byte{byte(g * 4), byte(g * 4), byte(g * 4)}
	}
	return k
}()

// WriteFile writes into the output directory.
func WriteFile(out, file string, data []byte) {
	if err := os.WriteFile(filepath.Join(out, file), data, 0o644); err != nil {
		panic(err)
	}
}

// WriteIdx writes a palette-index layer as the build scripts' writeIdx does.
func WriteIdx(out, file string, px []byte, w, h int) {
	data := EncodeIndexedPNG(px, w, h, Key, 0)
	WriteFile(out, file, data)
	fmt.Printf("%-16s %3dx%3d  %6dB\n", file, w, h, len(data))
}
