package aiz

import (
	"testing"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

func TestMatchesJS(t *testing.T) { lib.CheckStep(t, "build-aiz-assets.mjs", Build) }
