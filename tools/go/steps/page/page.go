// Package page assembles index.html from src/.
//
// The site stays a single static file -- that is what GitHub Pages serves and
// what makes the page work from a file:// URL with no server. The sources are
// split only for reading and editing:
//
//	src/index.html          markup, with a slot for each of the two below
//	src/style.css           -> <style>
//	src/generated/assets.js -> <script>, first  (generated, never hand-edited)
//	src/app.js              -> <script>, after  (all hand-written, no base64)
package page

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// Build writes index.html, unless it already matches.
func Build() {
	srcDir := filepath.Join(lib.Root(), "src")
	htmlFile := filepath.Join(lib.Root(), "index.html")
	read := func(f string) string { return string(lib.Must(os.ReadFile(filepath.Join(srcDir, f)))) }
	tpl := read("index.html")
	for _, slot := range []string{"/*{{STYLE}}*/", "//{{SCRIPT}}"} {
		if !strings.Contains(tpl, slot) {
			panic("src/index.html is missing the " + slot + " slot")
		}
	}
	assets := read(filepath.Join("generated", "assets.js"))
	app := read("app.js")
	if strings.Contains(app, "base64,") {
		panic("src/app.js contains base64 -- generated data belongs in src/generated/")
	}
	trim := func(s string) string { return strings.TrimRight(s, "\n") }
	out := strings.Replace(tpl, "/*{{STYLE}}*/", trim(read("style.css")), 1)
	out = strings.Replace(out, "//{{SCRIPT}}", trim(assets)+"\n\n"+trim(app), 1)
	// the deploy checks both of these; failing here is a better place to find out
	if !strings.Contains(out, "</html>") {
		panic("assembled page has no closing </html>")
	}
	if len(out) < 1000 {
		panic("assembled page looks truncated")
	}
	if before, err := os.ReadFile(htmlFile); err == nil && string(before) == out {
		fmt.Println("index.html already matches src/ -- nothing written")
		return
	}
	lib.WriteFile(lib.Root(), "index.html", []byte(out))
	fmt.Printf("index.html assembled (%d bytes)\n", len(out))
}
