// Sample Go program for the dreplay go-flow conformance test.
// Two business functions: classify (the entrypoint) calls tag (an interior helper).
// Both return business-shaped maps so the Flow binds observed operands + provenance.
package main

type Order struct {
	Amount   int
	Currency string
	Status   string
}

func tag(x int) string {
	if x > 0 {
		return "pos"
	}
	return "neg"
}

// classify is the entrypoint: returns a business object with observed fields.
func classify(x int) map[string]any {
	return map[string]any{
		"ok":     x > 0,
		"tag":    tag(x),
		"amount": x,
		"status": "settlement",
	}
}
