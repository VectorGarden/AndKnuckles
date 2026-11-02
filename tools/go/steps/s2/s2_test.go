package s2

import (
	"testing"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

func TestMatchesJS(t *testing.T) { lib.CheckStep(t, "build-s2-assets.mjs", Build) }
