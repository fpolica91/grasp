// dreplay C++ FLOW tracer — emits the Flow JSON protocol (spec §2, §8.8).
//
// This is a SHARED LIBRARY linked into the target program with
// -finstrument-functions. It implements the two __cyg_profile_func_* hooks GCC
// invokes on every function entry/exit, captures demangled function names +
// timing, and prints the Flow JSON document to stdout when the adapter-invoked
// entrypoint returns.
//
// The document shape is EXACTLY the protocol dreplay/instrument.py::_reduce
// consumes (same as the Python sys.settrace worker):
//
//   {
//     "events": [{"func","locals","return","dur"}, ...],
//     "constants": {"NAME": value, ...},
//     "defined_funcs": ["func1", ...],
//     "auth_calls": {"func": ["auth_func", ...]},
//     "outbound": [],
//     "return": value,
//     "exception": null
//   }
//
// HONESTY (principle #1 — observed, never guessed):
//   * function name + duration are OBSERVED (resolved from the program counter
//     via dladdr + __cxa_demangle; timed with a steady_clock);
//   * the entrypoint return value is captured from a callback the adapter's
//     generated wrapper sets (dreplay_set_return) — the wrapper observes the
//     real return and serializes it; the tracer only carries it;
//   * `locals` (interior argument VALUES) and `constants` are NOT recoverable
//     from -finstrument-functions alone (the hook receives only void* this_fn
//     and void* call_site — no DWARF frame walking is done here). We emit
//     per-event locals as empty {} and let the host's _reduce bind what it can.
//     We never fabricate operand values. This is the labelled honest partial:
//     call/return STRUCTURE + timing are observed; interior operand VALUES are
//     not (the host vocab deriver reads declared field names from source).
//
// To avoid tracing program startup (static initializers, C runtime, main) the
// trace is armed ONLY for the adapter-invoked entrypoint subtree, via a runtime
// enabled flag flipped in dreplay_invoke(). GCC has no per-function
// instrumentation toggle, so this gate is what scopes the trace to the target.
//
// Build:  g++ -shared -fPIC -O2 -std=c++17 cpp_tracer.cpp -o libcpp_tracer.so
//         (links libstdc++ + libdl by default with g++).
// Link target:  g++ -finstrument-functions target.cpp -L. -lcpp_tracer
//
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <cxxabi.h>   // __cxa_demangle — libstdc++.so.6, no extra link flag
#include <dlfcn.h>    // dladdr — libdl

namespace {

// ---- JSON string writer (forward decl) -------------------------------------
void write_json_string(FILE* out, const std::string& s);

// ---- runtime enable gate ---------------------------------------------------
// GCC fires __cyg hooks on EVERY function. We arm the gate on entry to
// dreplay_invoke() and disarm on its return, so only the target subtree traces.
std::atomic<bool> g_enabled{false};
bool g_failed = false;
std::string g_exc_msg;
std::string g_entry_return_json;   // pre-serialized JSON value, set by adapter

// ---- name cache: void* (this_fn) -> demangled name -------------------------
std::unordered_map<void*, std::string> g_name_cache;

const std::string& demangle_fn(void* fn) {
    auto it = g_name_cache.find(fn);
    if (it != g_name_cache.end()) return it->second;
    std::string sym = "<unknown>";
    Dl_info info{};
    if (dladdr(fn, &info) && info.dli_sname) {
        int status = 0;
        char* dem = abi::__cxa_demangle(info.dli_sname, nullptr, nullptr, &status);
        if (status == 0 && dem) {
            sym = dem;
            std::free(dem);
        } else {
            sym = info.dli_sname;  // C symbol, not mangled
        }
    }
    auto ins = g_name_cache.emplace(fn, std::move(sym));
    return ins.first->second;
}

// ---- per-thread call stack (nested enter/exit timing) ----------------------
struct Frame {
    void* fn;
    std::string name;     // normalized
    bool library;         // std/boost/etc — recorded for nesting, dropped from output
    double t_enter;
};
thread_local std::vector<Frame> g_stack;

// ---- captured events (one per completed call) ------------------------------
struct Event {
    std::string func;
    double dur;
};
std::vector<Event> g_events;

double now_seconds() {
    using namespace std::chrono;
    return duration<double>(steady_clock::now().time_since_epoch()).count();
}

// ---- name filtering + normalization ----------------------------------------
// Scope = the user's code only. The Python instrument restricts to the target
// package dir; the C++ equivalent is to drop standard/compiler-library frames
// (std::, __gnu_cxx::, __cxxabiv1::, boost::, etc.) — they are never business
// calls. This runs on the RAW demangled name (before normalization) so a
// library call rendered as "void std::basic_string<...>::fn(...)" is still
// detected via its std:: namespace, regardless of leading return-type tokens.
bool is_library_frame(const std::string& raw) {
    // A frame is library if any known namespace appears as a prefix token.
    // We check both "starts with NS::" and "starts with <type> NS::" by simply
    // searching for "::NS" boundaries is unreliable; instead test whether the
    // qualified name contains one of these namespaces at a word boundary.
    static const char* namespaces[] = {
        "std::", "__gnu_cxx::", "__cxxabiv1::", "boost::", "absl::",
        "google::", "tensorflow::", "torch::", "cv::", "__pstl::",
    };
    for (auto ns : namespaces) {
        // match "<ns>" either at start or right after a space (return type) or
        // after another type token boundary.
        if (raw.find(ns) != std::string::npos) {
            // Ensure it's a real namespace use, not a substring of a user type
            // like "mystd::foo". Require a preceding start/space/'<'.
            auto pos = raw.find(ns);
            if (pos == 0) return true;
            char before = raw[pos - 1];
            if (before == ' ' || before == '<') return true;
        }
    }
    if (raw.empty() || raw == "<unknown>") return true;
    return false;
}

// Normalize a demangled name for matching against spec.func + display:
//   "classify[abi:cxx11](int)"   →  "classify"
//   "foo::bar(int, char**)"      →  "foo::bar"
// We strip the GCC abi tag and the trailing (parameter-list). We do NOT attempt
// to strip a leading return type (template args with spaces made that brittle);
// library frames are already filtered on the raw name, so a surviving frame is
// a user symbol whose demangled form is either "name(...)" or a qualified
// "ns::name(...)". Stripping params + abi is enough for spec.func matching.
std::string normalize_name(std::string name) {
    // 1. strip [abi:...] marker
    auto abi = name.find("[abi:");
    if (abi != std::string::npos) {
        auto end = name.find(']', abi);
        if (end != std::string::npos) name.erase(abi, end - abi + 1);
    }
    // 2. strip trailing parameter list: first '(' at top level (not in '<>').
    int depth = 0;
    size_t paren = std::string::npos;
    for (size_t i = 0; i < name.size(); ++i) {
        if (name[i] == '<') ++depth;
        else if (name[i] == '>') { if (depth > 0) --depth; }
        else if (name[i] == '(' && depth == 0) { paren = i; break; }
    }
    if (paren != std::string::npos) name.erase(paren);
    // 3. trim trailing whitespace
    while (!name.empty() && std::isspace(static_cast<unsigned char>(name.back())))
        name.pop_back();
    return name;
}

}  // namespace

// ---- GCC instrumentation hooks --------------------------------------------
extern "C" {

void __cyg_profile_func_enter(void* this_fn, void* /*call_site*/) {
    if (!g_enabled.load(std::memory_order_relaxed)) return;
    const std::string& raw = demangle_fn(this_fn);
    bool lib = is_library_frame(raw);          // filter on RAW demangled name
    std::string nm = normalize_name(raw);      // normalize for output/matching
    g_stack.push_back(Frame{this_fn, std::move(nm), lib, now_seconds()});
}

void __cyg_profile_func_exit(void* this_fn, void* /*call_site*/) {
    if (!g_enabled.load(std::memory_order_relaxed)) return;
    if (g_stack.empty()) return;
    Frame f = std::move(g_stack.back());
    g_stack.pop_back();
    if (f.library) return;  // std/boost plumbing — observed for nesting, dropped
    double dur = now_seconds() - f.t_enter;
    if (dur < 0) dur = 0;
    g_events.push_back(Event{f.name, dur});
}

// ---- adapter-controlled entrypoint invocation ------------------------------
// The compiled target exposes `dreplay_entry(int argc, char** argv)` (the
// adapter generates a thin main that parses kwargs from argv, calls the real
// target fn, publishes its return via dreplay_set_return, then returns). The
// adapter wraps the real call in dreplay_invoke() so ONLY that subtree traces.
typedef int (*entry_fn_t)(int argc, char** argv);

void dreplay_set_return(const char* json_value) {
    g_entry_return_json = json_value ? json_value : "null";
}

// Emit the Flow JSON now (called by dreplay_invoke after the fn returns).
// Eager emission (not a destructor) keeps stdout clean: only the instrumented
// run produces a document, exactly once.
void dreplay_emit_flow();

int dreplay_invoke(entry_fn_t fn, int argc, char** argv) {
    g_enabled.store(true, std::memory_order_relaxed);
    g_failed = false;
    g_exc_msg.clear();
    int rc = 0;
    try {
        rc = fn(argc, argv);
    } catch (const std::exception& e) {
        g_failed = true;
        g_exc_msg = e.what();
        rc = -1;
    } catch (...) {
        g_failed = true;
        g_exc_msg = "unknown C++ exception";
        rc = -1;
    }
    g_enabled.store(false, std::memory_order_relaxed);
    dreplay_emit_flow();
    return rc;
}

}  // extern "C"

// ---- stdout JSON emitter ---------------------------------------------------
void dreplay_emit_flow() {
    FILE* out = stdout;
    std::fputs("{", out);

    // events
    std::fputs("\"events\":[", out);
    for (size_t i = 0; i < g_events.size(); ++i) {
        if (i) std::fputc(',', out);
        std::fputs("{\"func\":", out);
        write_json_string(out, g_events[i].func);
        // locals not recoverable from -finstrument-functions: empty {} (honest
        // gap; host _reduce tolerates it). per-event return unknown → null.
        std::fprintf(out, ",\"locals\":{},\"return\":null,\"dur\":%.6f}",
                     g_events[i].dur);
    }
    std::fputs("],", out);

    // constants — not derivable here (no AST); host vocab deriver reads source.
    std::fputs("\"constants\":{},", out);

    // defined_funcs — best-effort: every distinct observed func name.
    std::fputs("\"defined_funcs\":[", out);
    {
        std::unordered_set<std::string> seen;
        bool first = true;
        for (auto& e : g_events) {
            if (seen.insert(e.func).second) {
                if (!first) std::fputc(',', out);
                write_json_string(out, e.func);
                first = false;
            }
        }
    }
    std::fputs("],", out);

    std::fputs("\"auth_calls\":{},", out);
    std::fputs("\"outbound\":[],", out);

    if (g_failed) {
        std::fputs("\"return\":null,\"exception\":{", out);
        std::fputs("\"type\":\"CxxException\",\"message\":", out);
        write_json_string(out, g_exc_msg.empty() ? "exception" : g_exc_msg);
        std::fputs("}", out);  // close exception object; the doc closes below
    } else {
        std::fputs("\"return\":", out);
        std::fputs(g_entry_return_json.empty() ? "null"
                                               : g_entry_return_json.c_str(),
                   out);
        std::fputs(",\"exception\":null", out);
    }

    std::fputs("}\n", out);
    std::fflush(out);
}

namespace {
void write_json_string(FILE* out, const std::string& s) {
    std::fputc('"', out);
    for (char c : s) {
        switch (c) {
            case '"':  std::fputs("\\\"", out); break;
            case '\\': std::fputs("\\\\", out); break;
            case '\n': std::fputs("\\n", out); break;
            case '\r': std::fputs("\\r", out); break;
            case '\t': std::fputs("\\t", out); break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    std::fprintf(out, "\\u%04x", static_cast<unsigned char>(c));
                } else {
                    std::fputc(c, out);
                }
        }
    }
    std::fputc('"', out);
}
}  // namespace
