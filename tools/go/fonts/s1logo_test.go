package fonts

import (
	"os/exec"
	"testing"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// The three exports, as Go evaluates them, against what Node gets from the module.
func TestS1LogoMatchesJS(t *testing.T) {
	js, err := exec.Command("node", "--input-type=module", "-e",
		`import * as m from '`+lib.Tools()+`/font/s1-logo.mjs'; console.log(JSON.stringify([m.DESIGNS, m.SMALL, m.SONIC]))`).Output()
	if err != nil {
		t.Skip("no node:", err)
	}
	f := LoadS1Logo()
	if got := lib.Stringify([]any{f.Designs, f.Small, f.Sonic}) + "\n"; got != string(js) {
		t.Fatalf("differs from the module (%d vs %d bytes)", len(got), len(js))
	}
}
