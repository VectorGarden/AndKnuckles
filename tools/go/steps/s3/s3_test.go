package s3

import (
	"testing"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

func TestMatchesJS(t *testing.T) { lib.CheckStep(t, "build-s3-assets.mjs", Build) }
