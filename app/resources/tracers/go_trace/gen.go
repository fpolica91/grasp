package main

import (
	"fmt"
	"go/ast"
	"go/token"
	"strings"
)

// genMain generates package-main's entrypoint: unmarshal the JSON input into the entry
// func's typed params, call it (its frame is captured by instrumentation), emit Trace v1.
func genMain(fset *token.FileSet, fn *ast.FuncDecl, entry string) string {
	var binds []string
	var callArgs []string
	if fn.Type.Params != nil {
		for _, p := range fn.Type.Params.List {
			typ := typeString(fset, p.Type)
			for _, n := range p.Names {
				if n.Name == "_" || n.Name == "" {
					continue
				}
				binds = append(binds, fmt.Sprintf("\tvar %s %s\n\tjson.Unmarshal(__in[%q], &%s)", n.Name, typ, n.Name, n.Name))
				callArgs = append(callArgs, n.Name)
			}
		}
	}
	var b strings.Builder
	b.WriteString("package main\n\nimport (\n\t\"encoding/json\"\n\t\"os\"\n)\n\n")
	b.WriteString("func main() {\n")
	b.WriteString("\tdefer __gRecover()\n")
	b.WriteString(fmt.Sprintf("\t__gEntry = %q\n", entry))
	b.WriteString("\tif len(os.Args) > 1 { __gInputRaw = os.Args[len(os.Args)-1] }\n")
	b.WriteString("\tvar __in map[string]json.RawMessage\n")
	b.WriteString("\tjson.Unmarshal([]byte(__gInputRaw), &__in)\n")
	for _, bd := range binds {
		b.WriteString(bd + "\n")
	}
	b.WriteString(fmt.Sprintf("\t%s(%s)\n", fn.Name.Name, strings.Join(callArgs, ", ")))
	b.WriteString("\t__gStatus = \"returned\"\n")
	b.WriteString("\t__gEmit()\n")
	b.WriteString("}\n")
	return b.String()
}

// runtimeSrc — the trace collector injected into the throwaway package.
const runtimeSrc = `package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

type __gArg struct {
	Name string
	Val  interface{}
}

type __gFrame struct {
	Id       string      ` + "`json:\"id\"`" + `
	Parent   *string     ` + "`json:\"parent\"`" + `
	Seq      int         ` + "`json:\"seq\"`" + `
	Depth    int         ` + "`json:\"depth\"`" + `
	Fn       string      ` + "`json:\"fn\"`" + `
	File     string      ` + "`json:\"file\"`" + `
	Line     int         ` + "`json:\"line\"`" + `
	CallLine *int        ` + "`json:\"callLine\"`" + `
	Args     []__gVal    ` + "`json:\"args\"`" + `
	Ret      *__gVal     ` + "`json:\"ret\"`" + `
	Threw    interface{} ` + "`json:\"threw\"`" + `
	DurMs    float64     ` + "`json:\"durMs\"`" + `
	Language string      ` + "`json:\"language\"`" + `
	t        time.Time
}

type __gVal struct {
	Name string      ` + "`json:\"name\"`" + `
	Repr string      ` + "`json:\"repr\"`" + `
	Json interface{} ` + "`json:\"json\"`" + `
}

var (
	__gFrames   []*__gFrame
	__gStack    []*__gFrame
	__gSeq      int
	__gStatus   = "returned"
	__gThrew    interface{}
	__gEntry    string
	__gInputRaw = "{}"
)

func __repr(v interface{}) string {
	switch x := v.(type) {
	case string:
		return "'" + x + "'"
	case nil:
		return "nil"
	default:
		s := fmt.Sprintf("%v", v)
		if len(s) > 400 {
			s = s[:400] + "…"
		}
		return s
	}
}

func __toVals(args []__gArg) []__gVal {
	out := []__gVal{}
	for _, a := range args {
		out = append(out, __gVal{Name: a.Name, Repr: __repr(a.Val), Json: a.Val})
	}
	return out
}

func __gEnter(name string, args []__gArg, file string, line int) {
	__gSeq++
	var parent *string
	if len(__gStack) > 0 {
		p := __gStack[len(__gStack)-1].Id
		parent = &p
	}
	fr := &__gFrame{Id: fmt.Sprintf("f%d", __gSeq), Parent: parent, Seq: __gSeq, Depth: len(__gStack),
		Fn: name, File: file, Line: line, Args: __toVals(args), Language: "go", t: time.Now()}
	__gStack = append(__gStack, fr)
	__gFrames = append(__gFrames, fr)
}

func __gExit(rets []__gArg) {
	if len(__gStack) == 0 {
		return
	}
	fr := __gStack[len(__gStack)-1]
	__gStack = __gStack[:len(__gStack)-1]
	fr.DurMs = float64(time.Since(fr.t).Microseconds()) / 1000.0
	if len(rets) == 1 {
		fr.Ret = &__gVal{Name: "return", Repr: __repr(rets[0].Val), Json: rets[0].Val}
	} else if len(rets) > 1 {
		reprs := []string{}
		jsons := []interface{}{}
		for _, r := range rets {
			reprs = append(reprs, __repr(r.Val))
			jsons = append(jsons, r.Val)
		}
		joined := ""
		for i, s := range reprs {
			if i > 0 {
				joined += ", "
			}
			joined += s
		}
		fr.Ret = &__gVal{Name: "return", Repr: "(" + joined + ")", Json: jsons}
	}
}

func __gRecover() {
	if r := recover(); r != nil {
		__gStatus = "threw"
		__gThrew = map[string]interface{}{"type": "panic", "message": fmt.Sprintf("%v", r)}
		// mark the currently-open frame as having thrown
		if len(__gStack) > 0 {
			__gStack[len(__gStack)-1].Threw = __gThrew
		}
		__gEmit()
	}
}

var __gEmitted bool

func __gEmit() {
	if __gEmitted {
		return
	}
	__gEmitted = true
	var input interface{}
	json.Unmarshal([]byte(__gInputRaw), &input)
	var ret interface{}
	for _, f := range __gFrames {
		if f.Parent == nil && f.Ret != nil {
			ret = f.Ret
			break
		}
	}
	var dur float64
	for _, f := range __gFrames {
		if f.Parent == nil {
			dur = f.DurMs
			break
		}
	}
	d := map[string]interface{}{
		"grasp_trace_version": "1", "id": "go", "createdAt": 0, "entry": __gEntry,
		"language": "go", "how": "AST-instrumented go run of " + __gEntry, "gitRef": nil,
		"input": input, "status": __gStatus, "frames": __gFrames, "ret": ret,
		"threw": __gThrew, "durationMs": dur, "stdout": "", "stderr": "", "unobservable": nil,
	}
	b, _ := json.Marshal(d)
	os.Stdout.Write(b)
}
`
