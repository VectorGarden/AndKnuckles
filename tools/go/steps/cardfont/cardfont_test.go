package cardfont

import (
	"testing"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

func TestMatchesJS(t *testing.T) { lib.CheckStep(t, "build-card-font.mjs", Build) }
