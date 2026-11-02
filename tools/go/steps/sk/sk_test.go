package sk

import (
	"testing"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

func TestMatchesThePage(t *testing.T) { lib.CheckStep(t, Build) }
