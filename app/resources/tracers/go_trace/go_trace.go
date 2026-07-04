// grasp Go reference tracer — a self-contained skill asset the agent runs. It AST-rewrites
// the target package (Go is the authority on Go syntax, so we parse/print, never regex),
// runs the real function under `go run`, and emits a Trace v1 document on stdout.
//
//   go run go_trace.go --repo R --entry path/file.go:Func --input '{"a":48,"b":36}'
//
// Honesty: a parse/compile/run failure is reported as `unobservable`, never a fabricated
// frame or a fake thrown-error. The instrumented package is a throwaway copy inside the
// module (so imports resolve); it is removed afterwards.
package main

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func flag(name, def string) string {
	for i, a := range os.Args {
		if a == name && i+1 < len(os.Args) {
			return os.Args[i+1]
		}
	}
	return def
}

type doc struct {
	Version  string      `json:"grasp_trace_version"`
	ID       string      `json:"id"`
	Created  int64       `json:"createdAt"`
	Entry    string      `json:"entry"`
	Language string      `json:"language"`
	How      string      `json:"how"`
	GitRef   *string     `json:"gitRef"`
	Input    interface{} `json:"input"`
	Status   string      `json:"status"`
	Frames   []any       `json:"frames"`
	Ret      any         `json:"ret"`
	Threw    any         `json:"threw"`
	Duration *float64    `json:"durationMs"`
	Stdout   string      `json:"stdout"`
	Stderr   string      `json:"stderr"`
	Unobs    *unobs      `json:"unobservable"`
}
type unobs struct {
	Reason string `json:"reason"`
	Hint   string `json:"hint,omitempty"`
}

func unobservable(entry, reason, hint string) {
	d := doc{Version: "1", ID: "go", Entry: entry, Language: "go", How: "go tracer could not run",
		Status: "unobservable", Frames: []any{}, Unobs: &unobs{Reason: reason, Hint: hint}}
	b, _ := json.Marshal(d)
	os.Stdout.Write(b)
	os.Exit(0)
}

func main() {
	repo := flag("--repo", ".")
	entry := flag("--entry", "")
	input := flag("--input", "{}")
	repo, _ = filepath.Abs(repo)

	ix := strings.LastIndex(entry, ":")
	if ix < 0 {
		unobservable(entry, "entry must be path/to/file.go:FuncName", "e.g. math/gcd/extendedgcd.go:ExtendedRecursive")
	}
	relFile, funcName := entry[:ix], entry[ix+1:]
	pkgDir := filepath.Join(repo, filepath.Dir(relFile))
	if _, err := os.Stat(filepath.Join(repo, relFile)); err != nil {
		unobservable(entry, "entry file not found: "+relFile, "path is relative to the repo root")
	}

	// Parse the package to find the entry func's signature (for typed arg binding).
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, pkgDir, func(fi os.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, parser.ParseComments)
	if err != nil {
		unobservable(entry, "could not parse package: "+err.Error(), "the Go source must compile")
	}
	var entryFn *ast.FuncDecl
	var pkgName string
	var files []*ast.File
	for name, pkg := range pkgs {
		pkgName = name
		for _, f := range pkg.Files {
			files = append(files, f)
			for _, d := range f.Decls {
				if fn, ok := d.(*ast.FuncDecl); ok && fn.Name.Name == funcName && fn.Recv == nil {
					entryFn = fn
				}
			}
		}
	}
	if entryFn == nil {
		unobservable(entry, "func "+funcName+" not found (top-level, no receiver) in the package", "check the exported name")
	}

	// Build the throwaway instrumented package inside the module so imports resolve.
	tmp := filepath.Join(repo, "grasp_go_trace_tmp")
	os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		unobservable(entry, "could not create temp package: "+err.Error(), "")
	}
	defer os.RemoveAll(tmp)

	// Instrument + copy every non-test file of the package, renamed to package main.
	for _, f := range files {
		instrument(fset, f, filepath.Base(fset.Position(f.Pos()).Filename))
		f.Name.Name = "main"
		var buf bytes.Buffer
		if err := printer.Fprint(&buf, fset, f); err != nil {
			unobservable(entry, "could not print instrumented source: "+err.Error(), "")
		}
		out := buf.String()
		// strip the entrypoint reference to any pre-existing func main in the pkg (rare)
		os.WriteFile(filepath.Join(tmp, "src_"+filepath.Base(fset.Position(f.Pos()).Filename)), []byte(out), 0o644)
	}
	_ = pkgName

	os.WriteFile(filepath.Join(tmp, "grasp_runtime.go"), []byte(runtimeSrc), 0o644)
	os.WriteFile(filepath.Join(tmp, "grasp_main.go"), []byte(genMain(fset, entryFn, entry)), 0o644)

	// Run it. go run streams the Trace v1 JSON the generated main prints.
	cmd := exec.Command("go", "run", ".")
	cmd.Dir = tmp
	cmd.Args = append(cmd.Args, input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		unobservable(entry, "instrumented run failed: "+lastLines(msg, 3), "the function may need args the tracer could not bind, or deps not fetched")
	}
	os.Stdout.WriteString(stdout.String())
}

func lastLines(s string, n int) string {
	parts := strings.Split(strings.TrimSpace(s), "\n")
	if len(parts) > n {
		parts = parts[len(parts)-n:]
	}
	return strings.Join(parts, " ")
}
