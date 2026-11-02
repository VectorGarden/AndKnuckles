package s3

import (
	"testing"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

func TestMatchesThePage(t *testing.T) { lib.CheckStep(t, Build, "s3-banner-tiles.png") }
