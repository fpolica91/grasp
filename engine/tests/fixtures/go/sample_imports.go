// Sample Go program WITH a multi-line import block + a func main().
// Pins the go-flow import-merge fix: the target's own imports (strings/fmt) must
// survive into the assembled main.go, and the user's main() must be stripped
// (else 'main redeclared'). Before the fix, `import (` was never entered so the
// "strings"/"fmt" lines leaked as bare statements → the file never compiled and
// the entrypoint never ran.
package humanize

import (
	"fmt"
	"strings"
)

// Describe is the entrypoint: uses two stdlib packages from the import block.
func Describe(name string, count int) map[string]any {
	label := strings.ToUpper(name)
	return map[string]any{
		"label":  label,
		"pretty": fmt.Sprintf("%s x%d", label, count),
		"count":  count,
	}
}

func main() {
	// A real program's main() — must be stripped, not "redeclared".
	fmt.Println(Describe("widget", 3))
}
