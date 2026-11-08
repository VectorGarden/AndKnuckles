package music

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// The music the step writes is the MUSIC the committed page carries, byte for byte.
func TestMatchesThePage(t *testing.T) {
	out := t.TempDir()
	Build(out)
	got := string(lib.Must(os.ReadFile(filepath.Join(out, "music.json"))))
	page := string(lib.Must(os.ReadFile(filepath.Join(lib.Root(), "src", "generated", "assets.js"))))
	m := regexp.MustCompile(`(?m)^const MUSIC = (.*);$`).FindStringSubmatch(page)
	if m == nil {
		t.Fatal("the committed page has no MUSIC")
	}
	if m[1] != got {
		t.Fatal("music.json is not the MUSIC the committed page carries")
	}
}
