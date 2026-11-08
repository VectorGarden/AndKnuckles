package music

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
	"github.com/VectorGarden/AndKnuckles/tools/go/steps/aiz"
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

// The AIZ intro's music cues are where the aiz step's simulation has Knuckles:
// his cutscene starting, and him running off.
func TestAIZCuesFollowTheIntro(t *testing.T) {
	aiz.Build(t.TempDir())
	var song Song
	for _, s := range Songs {
		if s.Scene == "aiz" {
			song = s
		}
	}
	got := fmt.Sprint(song.Cues[0].Frame, song.Cues[1].Frame, song.Cues[2].Frame, song.Cues[3].Frame)
	k, r := aiz.Cues["knuckles"], aiz.Cues["runOff"]
	if want := fmt.Sprint(k, k+91, r, r+121); got != want {
		t.Errorf("AIZ cues on frames %s, the intro says %s", got, want)
	}
}
