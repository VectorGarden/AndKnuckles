// Command pipeline is the asset pipeline in Go: tools/build-all.mjs and every
// step it runs, producing the same bytes.
//
//	go -C tools/go run .                 every step, then the embed and the page
//	go -C tools/go run . --check         the same, leaving the repo as it found it,
//	                                     exiting non-zero if index.html would change
//	go -C tools/go run . <step> [outDir] one step: sk s3 aiz font cardfont s1 s2 embed page
//
// --check is what CI runs, next to the Node pipeline's own check: the two
// pipelines must agree with each other and with the committed page.
package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
	"github.com/VectorGarden/AndKnuckles/tools/go/steps/aiz"
	"github.com/VectorGarden/AndKnuckles/tools/go/steps/cardfont"
	"github.com/VectorGarden/AndKnuckles/tools/go/steps/embed"
	"github.com/VectorGarden/AndKnuckles/tools/go/steps/font"
	"github.com/VectorGarden/AndKnuckles/tools/go/steps/page"
	"github.com/VectorGarden/AndKnuckles/tools/go/steps/s1"
	"github.com/VectorGarden/AndKnuckles/tools/go/steps/s2"
	"github.com/VectorGarden/AndKnuckles/tools/go/steps/s3"
	"github.com/VectorGarden/AndKnuckles/tools/go/steps/sk"
)

// the build steps, in the order build-all.mjs runs them
var steps = []struct {
	name  string
	build func(out string)
}{
	{"sk", sk.Build}, {"s3", s3.Build}, {"aiz", aiz.Build}, {"font", font.Build},
	{"cardfont", cardfont.Build}, {"s1", s1.Build}, {"s2", s2.Build},
}

func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] != "--check" {
		out := ""
		if len(args) > 1 {
			out = args[1]
		}
		switch args[0] {
		case "embed":
			embed.Build(out)
		case "page":
			page.Build()
		default:
			for _, s := range steps {
				if s.name == args[0] {
					s.build(out)
					return
				}
			}
			fmt.Fprintln(os.Stderr, "unknown step", args[0])
			os.Exit(2)
		}
		return
	}
	os.Exit(all(len(args) > 0 && args[0] == "--check"))
}

// all is build-all: wipe out/, run every step, embed, assemble. With check, the
// two files the pipeline writes are restored afterwards whatever happened.
func all(check bool) (code int) {
	root := lib.Root()
	htmlFile := filepath.Join(root, "index.html")
	assetsFile := filepath.Join(root, "src", "generated", "assets.js")
	before, beforeA := lib.Must(os.ReadFile(htmlFile)), lib.Must(os.ReadFile(assetsFile))
	restore := func() {
		if check {
			lib.WriteFile(root, "index.html", before)
			lib.WriteFile(filepath.Dir(assetsFile), "assets.js", beforeA)
		}
	}
	defer func() {
		if r := recover(); r != nil {
			restore()
			fmt.Fprintln(os.Stderr, "\nbuild failed:", r)
			code = 1
		}
	}()
	// out/ is build output, and a stale file in it is exactly what this guards against
	out := filepath.Join(lib.Tools(), "out")
	if err := os.RemoveAll(out); err != nil {
		panic(err)
	}
	start := time.Now()
	for _, s := range steps {
		fmt.Printf("\n· %s\n", s.name)
		s.build("")
	}
	fmt.Println("\n· embed")
	embed.Build("")
	fmt.Println("\n· page")
	page.Build()
	fmt.Printf("\nbuilt in %s\n", time.Since(start).Round(time.Millisecond))
	if !check {
		return 0
	}
	after, afterA := lib.Must(os.ReadFile(htmlFile)), lib.Must(os.ReadFile(assetsFile))
	if bytes.Equal(before, after) && bytes.Equal(beforeA, afterA) {
		fmt.Println("\ncheck: index.html and src/generated/ match the pipeline")
		return 0
	}
	restore()
	fmt.Fprintln(os.Stderr, "\ncheck: index.html does NOT match the pipeline.")
	fmt.Fprintln(os.Stderr, "The committed page and tools/ have drifted. Run:")
	fmt.Fprintln(os.Stderr, "  go -C tools/go run .")
	return 1
}
