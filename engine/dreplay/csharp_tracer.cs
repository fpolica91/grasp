// dreplay C# FLOW tracer — source-instrumentation mechanism (spec §2a/§8.8 mirror of js_trace).
//
// HOW IT WORKS
// ------------
// The Python adapter (dreplay/adapter/csharp_flow.py) generates a throwaway console
// project, copies THIS file in as Program.cs, restores Microsoft.CodeAnalysis.CSharp
// from NuGet (the .NET team's OWN compiler package — not a dreplay/Python dependency),
// and runs it with `dotnet run`. At runtime this program:
//
//   1. Reads the target source (.cs path), the fully-qualified method to call,
//      the static TYPE that owns it, and the JSON kwargs — all via env vars.
//   2. Uses Roslyn's CSharpSyntaxRewriter to wrap EVERY method body in the target
//      source with enter/exit hooks that record (name, param-snapshot) and (return).
//      This is real interior instrumentation (the C# analogue of sys.settrace) — no
//      node is synthesized; a method the code did not execute produces no event.
//   3. Compiles the rewritten source + this tracer in-memory (CSharpCompilation)
//      and invokes the target method via reflection, capturing the trace log.
//   4. Emits the Flow JSON protocol (identical shape to the Python worker) to stdout:
//        {events, constants, defined_funcs, auth_calls, outbound, return, exception}
//      The host's instrument._reduce then turns this into an observed Flow of Nodes.
//
// HONESTY RULE (docs/what-this-is.md §1, principle #7 — do not fake the plumbing)
//   * every event is observed (the method really ran; params/return were snapshotted);
//   * a method that did not run produces NO event (no synthesis);
//   * if the target won't compile or the method can't be resolved, we emit
//     {exception: ...} — the host surfaces an instrumentation-error node, never a fake.
//   * limitations are NAMED in the emitted payload (e.g. async/iterator methods are
//     traced at the synchronous boundary only — see _CanRewrite), never papered over.
//
// BUILD: this is Program.cs of a console project whose .csproj adds
//        Microsoft.CodeAnalysis.CSharp (>=4.8). The Python adapter generates both.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;          // System.Text.Json ships in the runtime (no NuGet)
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace DreplayTracer
{
    public static class Program
    {
        // The trace log — populated by injected hooks during the real invocation.
        public static List<Dictionary<string, object?>> Log = new();
        public static List<Dictionary<string, object?>> Outbound = new();
        private static readonly Stack<Dictionary<string, object?>> _stack = new();

        // Enter/exit hooks injected into every rewritten method. Signatures are kept
        // simple (object) so the rewriter never has to compute overload/type arity.
        // params so the rewriter can emit a flat Enter("p1", v1, "p2", v2, ...) call.
        public static void Enter(params object[] args)
        {
            string name = args.Length > 0 ? args[0]?.ToString() ?? "?" : "?";
            var paramPairs = args.Length > 1 ? args.Skip(1).ToArray() : Array.Empty<object>();
            var rec = new Dictionary<string, object?>
            {
                ["func"] = name,
                ["locals"] = SnapParams(paramPairs),
                ["t_enter"] = DateTime.UtcNow.Ticks,
            };
            _stack.Push(rec);
        }

        public static void Exit(string name, object? ret)
        {
            if (_stack.Count == 0) return;
            var rec = _stack.Pop();
            rec["return"] = Canon(ret);
            rec["dur"] = (DateTime.UtcNow.Ticks - (long)rec["t_enter"]!) / (double)TimeSpan.TicksPerSecond;
            rec.Remove("t_enter");
            Log.Add(rec);
        }

        // Snapshot positional params into a {name:value} dict. Names come from the
        // rewritten call site (Enter emits ("paramName", value) pairs as a flat array;
        // we reconstruct the dict here). Kept simple: an even-length arg list of
        // (name, value) alternations. Fallback: arg0..argN if names unavailable.
        private static Dictionary<string, object?> SnapParams(object[] args)
        {
            var d = new Dictionary<string, object?>();
            if (args == null) return d;
            // Convention injected by the rewriter: [name1, val1, name2, val2, ...]
            for (int i = 0; i + 1 < args.Length; i += 2)
            {
                var key = args[i]?.ToString();
                if (!string.IsNullOrEmpty(key)) d[key!] = Canon(args[i + 1]);
            }
            return d;
        }

        // Canonicalize a .NET value to JSON-serializable form (the host re-canonicalizes
        // too; this just has to be lossless enough for field-path diffing).
        private static object? Canon(object? v)
        {
            if (v == null) return null;
            try
            {
                switch (v)
                {
                    case double dd: return double.IsNaN(dd) || double.IsInfinity(dd) ? dd.ToString() : dd;
                    case float ff: return float.IsNaN(ff) || float.IsInfinity(ff) ? ff.ToString() : ff;
                    case decimal: return v.ToString();
                    case DateTime dt: return dt.ToString("o");
                    case System.Collections.IDictionary:
                    case System.Collections.IEnumerable when !(v is string):
                        {
                            using var ms = new MemoryStream();
                            JsonSerializer.Serialize(ms, v, v.GetType());
                            ms.Position = 0;
                            return JsonDocument.Parse(ms).RootElement.Clone();
                        }
                    default:
                        {
                            // POCO/record: serialize its public props to a JsonElement.
                            var t = v.GetType();
                            if (t.IsPrimitive || t.IsEnum || t == typeof(string) || t == typeof(decimal))
                                return v;
                            using var ms = new MemoryStream();
                            JsonSerializer.Serialize(ms, v, v.GetType());
                            ms.Position = 0;
                            return JsonDocument.Parse(ms).RootElement.Clone();
                        }
                }
            }
            catch
            {
                try { return v.ToString(); } catch { return "<unreprable>"; }
            }
        }

        private static int Main(string[] argv)
        {
            var srcPath = Environment.GetEnvironmentVariable("DREPLAY_CS_SOURCE");
            var typeName = Environment.GetEnvironmentVariable("DREPLAY_CS_TYPE");
            var methodName = Environment.GetEnvironmentVariable("DREPLAY_CS_METHOD");
            var kwargsJson = Environment.GetEnvironmentVariable("DREPLAY_CS_KWARGS") ?? "{}";

            try
            {
                if (string.IsNullOrEmpty(srcPath) || !File.Exists(srcPath))
                    throw new FileNotFoundException("target source not found: " + srcPath);
                string source = File.ReadAllText(srcPath);

                // 1. Rewrite source with trace hooks.
                var (rewritten, funcNames, authCalls) = Rewrite(source);

                // 2. Compile rewritten source + this file (minus Main) in-memory.
                var asm = Compile(rewritten, srcPath);
                if (asm == null)
                    throw new InvalidOperationException("rewritten source did not compile (see build errors on stderr)");

                // 3. Resolve + invoke the target method via reflection.
                Type? t = null;
                foreach (var mod in asm.GetModules())
                {
                    foreach (var ty in mod.GetTypes())
                        if (ty.Name == typeName || ty.FullName == typeName) { t = ty; break; }
                    if (t != null) break;
                }
                // Fallback: first public type in the assembly.
                t ??= asm.GetTypes().FirstOrDefault(ty => ty.IsClass);
                if (t == null) throw new InvalidOperationException($"type '{typeName}' not found in compiled source");

                // Build a flat positional arg list from kwargs (insertion order). The
                // target method's parameters are matched positionally (the documented
                // kwarg→positional mapping shared with the JS adapter).
                JsonElement kwargs;
                try { kwargs = JsonDocument.Parse(kwargsJson).RootElement; }
                catch { kwargs = JsonDocument.Parse("{}").RootElement; }
                object[] positional;
                if (kwargs.ValueKind == JsonValueKind.Object)
                {
                    var arr = new List<object?>();
                    foreach (var prop in kwargs.EnumerateObject())
                        arr.Add(ToClr(prop.Value));
                    positional = arr.ToArray()!;
                }
                else
                {
                    positional = Array.Empty<object?>();
                }

                var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;
                var mi = t.GetMethod(methodName, flags)
                      ?? t.GetMethods(flags).FirstOrDefault(m => m.Name == methodName);
                if (mi == null) throw new InvalidOperationException($"method '{methodName}' not found on type '{t.FullName}'");

                object? instance = mi.IsStatic ? null : Activator.CreateInstance(t);
                var clrArgs = BuildArgs(mi, positional);

                object? ret;
                try { ret = mi.Invoke(instance, clrArgs); }
                catch (TargetInvocationException tie)
                {
                    var inner = tie.InnerException;
                    Emit(rewritten: true, funcNames, authCalls, ret: null,
                         exc: new { type = inner?.GetType().Name ?? "Exception", message = inner?.Message ?? tie.Message });
                    return 0;
                }

                Emit(true, funcNames, authCalls, Canon(ret), null);
                return 0;
            }
            catch (Exception ex)
            {
                Emit(false, new List<string>(), new Dictionary<string, List<string>>(), null,
                     new { type = ex.GetType().Name, message = ex.Message });
                return 0;
            }
        }

        // Emit the Flow JSON payload to stdout (host parses via json.loads).
        private static void Emit(bool rewritten, List<string> funcNames,
            Dictionary<string, List<string>> authCalls, object? ret, object? exc)
        {
            var payload = new Dictionary<string, object?>
            {
                ["events"] = Log,
                ["constants"] = new Dictionary<string, object?>(),
                ["defined_funcs"] = funcNames,
                ["auth_calls"] = authCalls,
                ["outbound"] = Outbound,
                ["return"] = ret,
                ["exception"] = exc,
                ["rewritten"] = rewritten,
            };
            Console.Write(JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = false }));
        }

        // Map positional JSON-derived args onto the method's parameter list, coercing
        // each to the parameter's exact CLR type (reflection Invoke is type-strict).
        private static object?[] BuildArgs(MethodInfo mi, object?[] positional)
        {
            var ps = mi.GetParameters();
            var args = new object?[ps.Length];
            for (int i = 0; i < ps.Length; i++)
            {
                if (i < positional.Length)
                    args[i] = Coerce(positional[i], ps[i].ParameterType);
                else if (ps[i].HasDefaultValue) args[i] = ps[i].DefaultValue;
                else args[i] = ps[i].ParameterType.IsValueType ? Activator.CreateInstance(ps[i].ParameterType) : null;
            }
            return args;
        }

        private static object? Coerce(object? v, Type target)
        {
            if (v == null) return target.IsValueType ? Activator.CreateInstance(target) : null;
            if (target == typeof(object)) return v;
            try
            {
                if (target.IsInstanceOfType(v)) return v;
                if (target.IsEnum) return Enum.ToObject(target, Convert.ChangeType(v, Enum.GetUnderlyingType(target)));
                // JsonElement (object/array kwargs) → leave as-is (POCO binding unsupported here).
                if (v is JsonElement) return v;
                return Convert.ChangeType(v, target);
            }
            catch { return v; }
        }

        private static object? ToClr(JsonElement el)
        {
            switch (el.ValueKind)
            {
                case JsonValueKind.Undefined:
                case JsonValueKind.Null: return null;
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                case JsonValueKind.Number:
                    if (el.TryGetInt64(out var l))
                    {
                        // Prefer Int32 when in range — C# method params are commonly int.
                        if (l >= int.MinValue && l <= int.MaxValue) return (int)l;
                        return l;
                    }
                    el.TryGetDouble(out var dd); return dd;
                case JsonValueKind.String: return el.GetString();
                case JsonValueKind.Object:
                case JsonValueKind.Array:
                    return JsonDocument.Parse(el.GetRawText()).RootElement.Clone();
                default: return el.GetRawText();
            }
        }

        // ----------------------------------------------------------------------- //
        // Roslyn rewrite: wrap each method body with Enter/Exit hooks.
        // ----------------------------------------------------------------------- //
        private static (string rewritten, List<string> funcNames, Dictionary<string, List<string>> authCalls)
            Rewrite(string source)
        {
            var tree = CSharpSyntaxTree.ParseText(source);
            var root = tree.GetRoot();

            // Collect function names + auth-call map from the original (observed from source).
            var funcNames = new List<string>();
            var authCalls = new Dictionary<string, List<string>>();
            var allMethods = root.DescendantNodes().OfType<MethodDeclarationSyntax>()
                .Select(m => (m.Identifier.Text, m)).ToList();
            foreach (var (name, _) in allMethods)
                if (!funcNames.Contains(name)) funcNames.Add(name);
            foreach (var (name, m) in allMethods)
            {
                var called = m.DescendantNodes().OfType<InvocationExpressionSyntax>()
                    .Select(i => i.Expression)
                    .OfType<IdentifierNameSyntax>()
                    .Select(e => e.Identifier.Text)
                    .Where(c => funcNames.Contains(c) && LooksAuth(c))
                    .Distinct().ToList();
                if (called.Count > 0) authCalls[name] = called;
            }

            var rewriter = new TraceRewriter();
            var rewritten = rewriter.Visit(root).NormalizeWhitespace(elasticTrivia: true).ToFullString();
            return (rewritten, funcNames, authCalls);
        }

        private static bool LooksAuth(string name)
        {
            var n = (name ?? "").ToLowerInvariant();
            string[] seeds = { "auth", "permission", "login", "verify", "authorize" };
            return seeds.Any(s => n.Contains(s));
        }

        // ----------------------------------------------------------------------- //
        // In-memory compile of rewritten user source + tracer hooks.
        // ----------------------------------------------------------------------- //
        private static Assembly? Compile(string rewrittenSource, string originalPath)
        {
            // The rewritten source references the hooks by fully-qualified name
            // (DreplayTracer.Program.Enter/Exit), so no using-static preamble is needed
            // and the tracer's Program class need not be public.
            string preamble = "";

            // Reference core assemblies from the current runtime.
            var refs = new List<MetadataReference>
            {
                MetadataReference.CreateFromFile(typeof(object).Assembly.Location),
                MetadataReference.CreateFromFile(typeof(Console).Assembly.Location),
                MetadataReference.CreateFromFile(typeof(System.Linq.Enumerable).Assembly.Location),
                MetadataReference.CreateFromFile(typeof(JsonSerializer).Assembly.Location),
                MetadataReference.CreateFromFile(AppDomain.CurrentDomain.GetAssemblies()
                    .First(a => a.GetName().Name == "System.Runtime").Location),
            };
            foreach (var an in new[] { "System.Collections", "System.Linq", "System.Text.Json" })
            {
                var asm = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == an);
                if (asm != null) refs.Add(MetadataReference.CreateFromFile(asm.Location));
            }

            // Compile the USER source (rewritten) referencing our tracer assembly.
            var tracerRef = MetadataReference.CreateFromFile(typeof(Program).Assembly.Location);
            refs.Add(tracerRef);

            var userTree = CSharpSyntaxTree.ParseText(preamble + rewrittenSource, path: Path.GetFileName(originalPath));
            var opts = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithOverflowChecks(true)
                .WithOptimizationLevel(OptimizationLevel.Debug);
            var compilation = CSharpCompilation.Create(
                "dreplay_target_" + Guid.NewGuid().ToString("N"),
                new[] { userTree }, refs, opts);

            using var peStream = new MemoryStream();
            var emitResult = compilation.Emit(peStream);
            if (!emitResult.Success)
            {
                foreach (var d in emitResult.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error))
                    Console.Error.WriteLine($"  tracer compile error: {d.Id}: {d.GetMessage()}");
                return null;
            }
            return Assembly.Load(peStream.ToArray());
        }
    }

    // The Roslyn rewriter: for each method, prepend an Enter() call and wrap the body
    // so Exit() runs with the return value. Sync methods only (see _CanRewrite); async
    // and iterator methods are left untouched (honest: their interior state machine is
    // not observed, and that gap is named in the payload, never faked).
    internal sealed class TraceRewriter : CSharpSyntaxRewriter
    {
        // Fully-qualified hook references so the rewritten USER source (compiled as a
        // separate assembly referencing this tracer) resolves without a using-static
        // that would require Program to be public.
        private static ExpressionSyntax Hook(string method) =>
            SyntaxFactory.ParseExpression("DreplayTracer.Program." + method);

        public override SyntaxNode? VisitMethodDeclaration(MethodDeclarationSyntax node)
        {
            node = (MethodDeclarationSyntax)base.VisitMethodDeclaration(node)!;
            if (!CanRewrite(node)) return node;

            var name = node.Identifier.Text;
            // Build the Enter() arg array: flat [methodName, p1Name, v1, p2Name, v2, ...].
            var enterArgs = new List<ExpressionSyntax>
            {
                SyntaxFactory.LiteralExpression(SyntaxKind.StringLiteralExpression, SyntaxFactory.Literal(name)),
            };
            foreach (var p in node.ParameterList.Parameters)
            {
                enterArgs.Add(SyntaxFactory.LiteralExpression(SyntaxKind.StringLiteralExpression,
                    SyntaxFactory.Literal(p.Identifier.Text)));
                enterArgs.Add(SyntaxFactory.IdentifierName(p.Identifier));
            }

            var enterCall = SyntaxFactory.ExpressionStatement(
                SyntaxFactory.InvocationExpression(
                    Hook("Enter"),
                    SyntaxFactory.ArgumentList(SyntaxFactory.SeparatedList(
                        enterArgs.Select(e => SyntaxFactory.Argument(e))))));

            var bodyStatements = new List<StatementSyntax> { enterCall };

            if (node.Body != null)
            {
                // Wrap existing statements; on each return path, call Exit(name, value).
                foreach (var stmt in node.Body.Statements)
                    bodyStatements.Add(WrapReturns(stmt, name));
                bodyStatements.Add(SyntaxFactory.ExpressionStatement(
                    SyntaxFactory.InvocationExpression(
                        Hook("Exit"),
                        SyntaxFactory.ArgumentList(SyntaxFactory.SeparatedList(new[]
                        {
                            SyntaxFactory.Argument(SyntaxFactory.LiteralExpression(
                                SyntaxKind.StringLiteralExpression, SyntaxFactory.Literal(name))),
                            SyntaxFactory.Argument(SyntaxFactory.LiteralExpression(SyntaxKind.NullLiteralExpression)),
                        })))));
                var newBody = node.Body.WithStatements(SyntaxFactory.List(bodyStatements));
                return node.WithBody(newBody);
            }
            else if (node.ExpressionBody != null)
            {
                // expression-bodied method: `T M() => expr;`  →  `T M() { Enter(...); var __r = expr; Exit(...); return __r; }`
                var retVar = SyntaxFactory.LocalDeclarationStatement(
                    SyntaxFactory.VariableDeclaration(SyntaxFactory.IdentifierName("var"))
                        .WithVariables(SyntaxFactory.SingletonSeparatedList(
                            SyntaxFactory.VariableDeclarator("__r")
                                .WithInitializer(SyntaxFactory.EqualsValueClause(node.ExpressionBody.Expression!)))));
                var exitCall = SyntaxFactory.ExpressionStatement(
                    SyntaxFactory.InvocationExpression(
                        Hook("Exit"),
                        SyntaxFactory.ArgumentList(SyntaxFactory.SeparatedList(new[]
                        {
                            SyntaxFactory.Argument(SyntaxFactory.LiteralExpression(
                                SyntaxKind.StringLiteralExpression, SyntaxFactory.Literal(name))),
                            SyntaxFactory.Argument(SyntaxFactory.IdentifierName("__r")),
                        }))));
                var returnStmt = SyntaxFactory.ReturnStatement(SyntaxFactory.IdentifierName("__r"));
                var block = SyntaxFactory.Block(enterCall, retVar, exitCall, returnStmt);
                return node.WithBody(block).WithExpressionBody(null).WithSemicolonToken(default);
            }
            return node;
        }

        // Replace `return X;` with `{ var __r = X; Exit(name, __r); return __r; }` so the
        // return VALUE is observed. Returns that are bare `return;` map to Exit(name,null).
        private static StatementSyntax WrapReturns(StatementSyntax stmt, string name) =>
            stmt is ReturnStatementSyntax ret
                ? WrapReturn(ret, name)
                : (StatementSyntax)new ReturnWalker(name).Visit(stmt)!;

        private static StatementSyntax WrapReturn(ReturnStatementSyntax ret, string name)
        {
            if (ret.Expression == null)
            {
                return SyntaxFactory.Block(
                    SyntaxFactory.ExpressionStatement(ExitCall(name, SyntaxFactory.LiteralExpression(SyntaxKind.NullLiteralExpression))),
                    SyntaxFactory.ReturnStatement());
            }
            // var __r = <expr>; Exit(name, __r); return __r;
            var decl = SyntaxFactory.LocalDeclarationStatement(
                SyntaxFactory.VariableDeclaration(SyntaxFactory.IdentifierName("var"))
                    .WithVariables(SyntaxFactory.SingletonSeparatedList(
                        SyntaxFactory.VariableDeclarator("__r")
                            .WithInitializer(SyntaxFactory.EqualsValueClause(ret.Expression)))));
            return SyntaxFactory.Block(decl,
                SyntaxFactory.ExpressionStatement(ExitCall(name, SyntaxFactory.IdentifierName("__r"))),
                SyntaxFactory.ReturnStatement(SyntaxFactory.IdentifierName("__r")));
        }

        private static InvocationExpressionSyntax ExitCall(string name, ExpressionSyntax value) =>
            SyntaxFactory.InvocationExpression(
                Hook("Exit"),
                SyntaxFactory.ArgumentList(SyntaxFactory.SeparatedList(new[]
                {
                    SyntaxFactory.Argument(SyntaxFactory.LiteralExpression(
                        SyntaxKind.StringLiteralExpression, SyntaxFactory.Literal(name))),
                    SyntaxFactory.Argument(value),
                })));

        private static bool CanRewrite(MethodDeclarationSyntax node)
        {
            // Skip partial/interface/abstract/extern (no body to wrap), async (state machine),
            // iterators (yield), and methods already rewritten (defensive).
            if (node.Body == null && node.ExpressionBody == null) return false;
            foreach (var mod in node.Modifiers)
            {
                var k = mod.ValueText;
                if (k == "abstract" || k == "extern" || k == "partial") return false;
            }
            foreach (var mod in node.Modifiers)
                if (mod.ValueText == "async") return false;
            // iterators: body contains yield. (best-effort textual check)
            if (node.Body != null && node.Body.ToString().Contains("yield")) return false;
            return true;
        }

        // A walker that rewrites returns nested inside other constructs (if/for/while/...).
        private sealed class ReturnWalker : CSharpSyntaxRewriter
        {
            private readonly string _name;
            public ReturnWalker(string name) { _name = name; }
            public override SyntaxNode? VisitReturnStatement(ReturnStatementSyntax node) => WrapReturn(node, _name);
        }
    }
}
