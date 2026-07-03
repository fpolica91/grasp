// Command instrument is dreplay's Go source rewriter (spec §2 tracer mechanism).
//
// It reads a single .go source file on stdin and writes a rewritten file on stdout
// where every top-level (and nested) func declaration is wrapped so that:
//
//   - on entry it records the function name + its argument values;
//   - on exit  it records the returned value.
//
// The hooks (__dtEnter / __dtExit) live in a tiny runtime that the Python adapter
// prepends to the rewritten file (see go_trace.py). This program only does the AST
// rewrite — Go is the authority on Go syntax, so we parse/print with go/printer,
// never regex.
//
// Rewrite strategy (matches js_trace.py): one function per pass, reparse each pass,
// so nested functions rewrite without offset bookkeeping. Already-instrumented funcs
// are detected by a sentinel import and skipped, bounding the loop.
//
// Honesty: if the source does not parse, we print nothing to stdout and exit non-zero;
// the Python caller then falls back to endpoints-only (go_flow.py), NEVER fakes a node.
package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
)

const sentinel = "__dreplay_traced__"

func main() {
	src, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read stdin: %v\n", err)
		os.Exit(2)
	}

	out := string(src)
	changed := false
	// One function per pass, reparse each pass — offsets stay fresh, nesting-safe.
	for i := 0; i < 500; i++ { // bound against pathological input
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, "src.go", out, parser.ParseComments)
		if err != nil {
			break // source unparsable as-is → stop (caller falls back honestly)
		}
		target := findFirstFunc(file)
		if target == nil {
			break
		}
		out = rewriteOne(fset, file, target, out)
		changed = true
	}
	if !changed {
		// Nothing rewriteable; emit the original unchanged so the harness still runs
		// (endpoints-only — the runtime main records at least the entrypoint).
		fmt.Print(out)
		return
	}
	fmt.Print(out)
}

// findFirstFunc returns the first (by source position) rewriteable FuncDecl, or nil.
func findFirstFunc(file *ast.File) *ast.FuncDecl {
	var best *ast.FuncDecl
	var bestPos token.Pos = token.NoPos
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok {
			continue
		}
		if fn.Name == nil {
			continue
		}
		// Skip the entrypoint's OWN frame (main / the harness) — it is covered by the
		// input/return nodes. We skip by name only for the literal "main"; the real
		// entrypoint skip happens in the Python reducer via the func name.
		if fn.Name.Name == "main" {
			continue
		}
		if isInstrumented(fn) {
			continue
		}
		if best == nil || fn.Pos() < bestPos {
			best = fn
			bestPos = fn.Pos()
		}
	}
	return best
}

// isInstrumented detects our sentinel to avoid re-rewriting every pass.
func isInstrumented(fn *ast.FuncDecl) bool {
	var found bool
	ast.Inspect(fn, func(n ast.Node) bool {
		ce, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if id, ok := ce.Fun.(*ast.Ident); ok && id.Name == sentinel {
			found = true
			return false
		}
		return true
	})
	return found
}

// rewriteOne rewrites a single FuncDecl to capture entry args AND every return value.
//
// Strategy: rewrite the result-list signature so its results are NAMED, then prepend an
// enter hook + a deferred exit hook that reads those named results. Because the results
// are now named, every `return EXPRS...` in the body assigns EXPRS to them automatically
// (Go semantics) — no return-statement rewriting needed. The deferred hook therefore
// OBSERVES the actual returned values on every exit path. Functions with no results get
// an empty exit hook. This is bulletproof against bare returns, early returns, and
// multi-value returns.
func rewriteOne(fset *token.FileSet, file *ast.File, fn *ast.FuncDecl, src string) string {
	body := fn.Body
	if body == nil || body.Lbrace == token.NoPos || body.Rbrace == token.NoPos {
		return markSentinel(src, fset, fn)
	}

	name := fn.Name.Name
	argList := argNames(fn.Type.Params)

	enterArgs := fmt.Sprintf("%q", name)
	for _, a := range argList {
		enterArgs += fmt.Sprintf(", %s", a)
	}

	// Determine the result variable names. If results are already named, reuse them.
	// Otherwise synthesize __dreplay_rN names and rewrite the signature's result list
	// to declare them as named results.
	resultVars := resultNames(fn.Type.Results)
	sigEnd := body.Pos() // signature ends where the body '{' begins
	sigEndIdx := fset.Position(sigEnd).Offset
	bodyOpenIdx := fset.Position(body.Lbrace).Offset
	bodyCloseIdx := fset.Position(body.Rbrace).Offset

	// The results clause text (between the params ')' or the bare func-type and the body).
	resultsClause := ""
	resultsStart := -1
	if fn.Type.Results != nil && fn.Type.Results.Pos() != token.NoPos {
		resultsStart = fset.Position(fn.Type.Results.Pos()).Offset
		resultsClause = src[resultsStart:sigEndIdx]
	}

	needsSigRewrite := false
	if countResults(fn.Type.Results) > 0 && len(resultVars) == 0 {
		// Unnamed results → synthesize names + rewrite the clause.
		needsSigRewrite = true
		n := countResults(fn.Type.Results)
		resultVars = make([]string, n)
		for i := 0; i < n; i++ {
			resultVars[i] = fmt.Sprintf("__dreplay_r%d", i)
		}
		// Build a new results clause: name each existing type with our var.
		newClause := buildNamedResultsClause(fn.Type.Results, resultVars)
		resultsClause = newClause
	}

	exitList := "nil"
	if len(resultVars) > 0 {
		joined := ""
		for i, r := range resultVars {
			if i > 0 {
				joined += ", "
			}
			joined += r
		}
		exitList = "[]any{" + joined + "}"
	}

	hook := fmt.Sprintf(
		"%s(%s);\n defer func(){ __dtExit(%q, %s) }();\n",
		sentinel, enterArgs, name, exitList)

	// Assemble: optionally replace results clause, then inject hook into body.
	if needsSigRewrite && resultsStart >= 0 {
		// Replace [resultsStart, sigEndIdx) with the new named clause.
		prefix := src[:resultsStart] + resultsClause
		bodyPart := src[sigEndIdx:bodyOpenIdx+1] + "\n" + hook + src[bodyOpenIdx+1:bodyCloseIdx] + src[bodyCloseIdx:]
		return prefix + bodyPart
	}
	// No signature change: just inject the hook into the body.
	return src[:bodyOpenIdx+1] + "\n" + hook + src[bodyOpenIdx+1:bodyCloseIdx] + src[bodyCloseIdx:]
}

// buildNamedResultsClause produces a Go results clause string naming each result.
// e.g. for results `(int, error)` and vars [a,b] → "(a int, b error)".
func buildNamedResultsClause(fl *ast.FieldList, vars []string) string {
	if fl == nil || len(fl.List) == 0 {
		return ""
	}
	// Reconstruct the type text per field from the source span.
	var parts []string
	vi := 0
	for _, f := range fl.List {
		typeText := reconstructTypeText(f.Type)
		if len(f.Names) == 0 {
			// unnamed single result → name it
			if vi < len(vars) {
				parts = append(parts, fmt.Sprintf("%s %s", vars[vi], typeText))
				vi++
			}
		} else {
			for _, n := range f.Names {
				if vi < len(vars) {
					parts = append(parts, fmt.Sprintf("%s %s", vars[vi], typeText))
					vi++
				} else {
					parts = append(parts, fmt.Sprintf("%s %s", n.Name, typeText))
				}
			}
		}
	}
	return "(" + joinStrings(parts, ", ") + ")"
}

func reconstructTypeText(t ast.Expr) string {
	switch x := t.(type) {
	case *ast.Ident:
		return x.Name
	case *ast.StarExpr:
		return "*" + reconstructTypeText(x.X)
	case *ast.SelectorExpr:
		return reconstructTypeText(x.X) + "." + x.Sel.Name
	case *ast.ArrayType:
		if x.Len == nil {
			return "[]" + reconstructTypeText(x.Elt)
		}
		return "[]" + reconstructTypeText(x.Elt)
	case *ast.MapType:
		return "map[" + reconstructTypeText(x.Key) + "]" + reconstructTypeText(x.Value)
	case *ast.InterfaceType:
		return "any"
	case *ast.StructType:
		return "struct{}"
	default:
		return "any" // conservative fallback — rare for return types
	}
}

func joinStrings(ss []string, sep string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += sep
		}
		out += s
	}
	return out
}

// markSentinel patches the func's body start with a no-op sentinel call so the
// per-pass loop moves past it.
func markSentinel(src string, fset *token.FileSet, fn *ast.FuncDecl) string {
	if fn.Body == nil {
		return src
	}
	idx := fset.Position(fn.Body.Lbrace).Offset
	return src[:idx+1] + "\n" + sentinel + "(\"\");\n" + src[idx+1:]
}

func argNames(fl *ast.FieldList) []string {
	if fl == nil {
		return nil
	}
	var out []string
	for _, f := range fl.List {
		if len(f.Names) == 0 {
			// unnamed param — synthesize a stable name
			out = append(out, fmt.Sprintf("_arg%d", len(out)))
			continue
		}
		for _, n := range f.Names {
			out = append(out, n.Name)
		}
	}
	return out
}

func resultNames(fl *ast.FieldList) []string {
	if fl == nil {
		return nil
	}
	var out []string
	for _, f := range fl.List {
		if len(f.Names) == 0 {
			continue
		}
		for _, n := range f.Names {
			out = append(out, n.Name)
		}
	}
	return out
}

// countResults returns the arity (not names) of the result list.
func countResults(fl *ast.FieldList) int {
	if fl == nil {
		return 0
	}
	n := 0
	for _, f := range fl.List {
		if len(f.Names) == 0 {
			n++ // unnamed single result
		} else {
			n += len(f.Names)
		}
	}
	return n
}

