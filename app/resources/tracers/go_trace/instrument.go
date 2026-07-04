package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"strings"
)

// mustStmt parses a single statement (in isolation) into an ast.Stmt to splice into a body.
// The identifiers it references (params, named results) resolve at compile time in scope.
func mustStmt(src string) ast.Stmt {
	f, err := parser.ParseFile(token.NewFileSet(), "s.go", "package p\nfunc _(){\n"+src+"\n}", 0)
	if err != nil {
		return nil
	}
	body := f.Decls[0].(*ast.FuncDecl).Body
	if len(body.List) == 0 {
		return nil
	}
	return body.List[0]
}

func typeString(fset *token.FileSet, e ast.Expr) string {
	var b strings.Builder
	printer.Fprint(&b, fset, e)
	return b.String()
}

// instrument wraps every top-level func (except main) so a real run records enter args and
// exit return values via the __g* runtime. Results are NAMED so a deferred hook observes the
// actual returned values on every exit path (bulletproof against early/bare/multi returns).
func instrument(fset *token.FileSet, file *ast.File, filename string) {
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil || fn.Name.Name == "main" {
			continue
		}
		line := fset.Position(fn.Pos()).Line

		// argument key/value list from named params
		var argParts []string
		if fn.Type.Params != nil {
			for _, p := range fn.Type.Params.List {
				for _, n := range p.Names {
					if n.Name == "_" || n.Name == "" {
						continue
					}
					argParts = append(argParts, fmt.Sprintf("{%q, %s}", n.Name, n.Name))
				}
			}
		}
		argsLit := "[]__gArg{" + strings.Join(argParts, ", ") + "}"

		// ensure named results, collect their identifiers
		var retNames []string
		if fn.Type.Results != nil {
			ri := 0
			for _, r := range fn.Type.Results.List {
				if len(r.Names) == 0 {
					name := fmt.Sprintf("__gr%d", ri)
					ri++
					r.Names = []*ast.Ident{ast.NewIdent(name)}
					retNames = append(retNames, name)
				} else {
					for _, n := range r.Names {
						if n.Name == "_" || n.Name == "" {
							name := fmt.Sprintf("__gr%d", ri)
							n.Name = name
						}
						retNames = append(retNames, n.Name)
						ri++
					}
				}
			}
		}
		var retParts []string
		for _, rn := range retNames {
			retParts = append(retParts, fmt.Sprintf("{%q, %s}", "", rn))
		}
		retsLit := "[]__gArg{" + strings.Join(retParts, ", ") + "}"

		enter := mustStmt(fmt.Sprintf("__gEnter(%q, %s, %q, %d)", fn.Name.Name, argsLit, filename, line))
		exit := mustStmt(fmt.Sprintf("defer func() { __gExit(%s) }()", retsLit))
		if enter == nil || exit == nil {
			continue
		}
		fn.Body.List = append([]ast.Stmt{enter, exit}, fn.Body.List...)
	}
}
