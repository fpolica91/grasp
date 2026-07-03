package dreplay.agent.recorder;

import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The runtime recorder: every instrumented method calls {@link #enter} on entry and
 * {@link #exit} on return/throw. The recorder pairs them by call-stack discipline
 * into events and emits the Flow JSON protocol to <b>stdout</b> via {@link #flush}.
 *
 * <p>Protocol emitted (identical in shape to the Python worker's, consumed by
 * {@code dreplay.instrument._reduce}):
 * <pre>
 * {
 *   "events": [{"func":"name","locals":{"arg":value},"return":value,"dur":0.001}, ...],
 *   "constants": {"NAME": value, ...},
 *   "defined_funcs": ["func1", ...],
 *   "auth_calls": {"func": ["auth_func", ...]},
 *   "outbound": [],
 *   "return": value,
 *   "exception": null
 * }
 * </pre>
 *
 * <p>HONESTY RULE (principle #1): only observed values are recorded. The recorder
 * never invents a field, a value, or an event. {@code enter} snapshots the actual
 * arguments the JVM passed; {@code exit} records the actual value returned (or the
 * thrown throwable). Values are canonicalized to JSON-safe shapes via
 * {@link #canon}: cycles are broken with a {@code <cycle>} placeholder, hostile
 * {@code toString()} implementations are caught, and unknown/unrepresentable values
 * degrade to a typed placeholder rather than crash the target.
 *
 * <p>Thread model: events are recorded per-thread (a thread-local frame stack) and
 * merged into the single global event list at flush time. Durations are measured
 * (real elapsed nanos, divided to seconds) — observed, never estimated.
 */
public final class FlowRecorder {

    /** One frame per in-flight method, per thread. */
    private static final ThreadLocal<java.util.ArrayDeque<Frame>> STACK =
            ThreadLocal.withInitial(java.util.ArrayDeque::new);

    /** The merged, ordered event list across all threads. Synchronized on append. */
    private static final java.util.List<Map<String, Object>> EVENTS = new java.util.ArrayList<>();

    /** Set true once flush() has run so a second shutdown hook can't double-emit. */
    private static volatile boolean flushed = false;

    private FlowRecorder() {
    }

    /** Injected at method entry. {@code args} are the method's declared arguments. */
    public static void enter(String name, Object[] args) {
        Frame f = new Frame();
        f.func = name;
        f.args = args;
        f.tEnter = System.nanoTime();
        STACK.get().push(f);
    }

    /** Injected at method exit (normal or exceptional). {@code value} is the return
     *  value (boxed primitive / object) or the thrown throwable, or {@code null}. */
    public static void exit(Object value, String name) {
        java.util.ArrayDeque<Frame> stack = STACK.get();
        if (stack.isEmpty()) {
            // Defensive: an exit with no matching enter (e.g. transformer edge case)
            // is dropped rather than corrupt the event list. Observed run, slightly
            // fewer nodes — never a fabricated one.
            return;
        }
        Frame f = stack.pop();
        double dur = (System.nanoTime() - f.tEnter) / 1_000_000_000.0;

        Map<String, Object> locals = new LinkedHashMap<>();
        if (f.args != null) {
            // The local names are unknown to bytecode (no debug info guaranteed), so
            // we bind by position: arg0, arg1, ... The Python reducer treats these as
            // observed operands keyed by name. (This matches the JS adapter, which
            // also loses param names and binds args positionally.)
            for (int i = 0; i < f.args.length; i++) {
                locals.put("arg" + i, canon(f.args[i]));
            }
        }

        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("func", f.func);
        ev.put("locals", locals);
        ev.put("return", canon(value));
        ev.put("dur", round(dur));
        synchronized (EVENTS) {
            EVENTS.add(ev);
        }
    }

    /** Emit the Flow JSON to stdout. Called from a JVM shutdown hook. */
    public static synchronized void flush() {
        if (flushed) {
            return;
        }
        flushed = true;
        Map<String, Object> root = new LinkedHashMap<>();
        synchronized (EVENTS) {
            root.put("events", new java.util.ArrayList<>(EVENTS));
        }
        root.put("constants", new LinkedHashMap<>());
        root.put("defined_funcs", new java.util.ArrayList<String>());
        root.put("auth_calls", new LinkedHashMap<>());
        root.put("outbound", new java.util.ArrayList<>());
        // The top-level "return"/"exception" are filled by the harness wrapper
        // (JavaMain below) if present; the recorder alone cannot know the
        // entrypoint's outermost outcome, so they default to null here. The Python
        // adapter derives the return node from the events of the entrypoint frame.
        root.put("return", null);
        root.put("exception", null);
        try {
            System.out.println(Json.write(root));
        } catch (Throwable t) {
            // Never let the recorder's serialization crash the target's exit.
            System.err.println("[dreplay] flush failed: " + t);
        }
    }

    // ---------------------------------------------------------------- //
    // Canonicalization — turn an arbitrary JVM value into a JSON-safe shape.
    // ---------------------------------------------------------------- //
    static Object canon(Object v) {
        return canon(v, new IdentityHashMap<>(), 0);
    }

    @SuppressWarnings("unchecked")
    private static Object canon(Object v, IdentityHashMap<Object, Boolean> seen, int depth) {
        if (depth > 16) {
            return "<too-deep>";
        }
        if (v == null) {
            return null;
        }
        Class<?> c = v.getClass();
        if (v instanceof String) {
            String s = (String) v;
            return s.length() > 2000 ? s.substring(0, 2000) + "<truncated>" : s;
        }
        if (v instanceof Number || v instanceof Boolean) {
            return v;
        }
        if (v instanceof Character) {
            return v.toString();
        }
        if (v instanceof java.util.Date) {
            return ((java.util.Date) v).getTime();
        }
        // Cycle guard: objects already on the current path → placeholder.
        if (seen.containsKey(v)) {
            return "<cycle>";
        }
        if (c.isArray()) {
            seen.put(v, Boolean.TRUE);
            int n = Array.getLength(v);
            java.util.List<Object> out = new java.util.ArrayList<>(Math.min(n, 64));
            for (int i = 0; i < n && i < 64; i++) {
                out.add(canon(Array.get(v, i), seen, depth + 1));
            }
            if (n > 64) {
                out.add("<truncated:" + (n - 64) + " more>");
            }
            return out;
        }
        if (v instanceof java.util.Map) {
            seen.put(v, Boolean.TRUE);
            Map<String, Object> out = new LinkedHashMap<>();
            int i = 0;
            for (Object entry : ((Map<Object, Object>) v).entrySet()) {
                if (i++ >= 32) {
                    break;
                }
                Map.Entry<Object, Object> e = (Map.Entry<Object, Object>) entry;
                out.put(String.valueOf(e.getKey()), canon(e.getValue(), seen, depth + 1));
            }
            return out;
        }
        if (v instanceof Iterable) {
            seen.put(v, Boolean.TRUE);
            java.util.List<Object> out = new java.util.ArrayList<>();
            int i = 0;
            for (Object item : (Iterable<?>) v) {
                if (i++ >= 64) {
                    out.add("<truncated>");
                    break;
                }
                out.add(canon(item, seen, depth + 1));
            }
            return out;
        }
        // A plain data object (POJO/record): reflect its declared fields. This is how
        // the reducer binds business operands — {field: value, ...}. Synthetic and
        // outer-this fields are skipped.
        seen.put(v, Boolean.TRUE);
        Map<String, Object> out = new LinkedHashMap<>();
        try {
            Class<?> k = c;
            int fieldCount = 0;
            while (k != null && k != Object.class && fieldCount < 24) {
                for (Field f : k.getDeclaredFields()) {
                    int mod = f.getModifiers();
                    if (java.lang.reflect.Modifier.isStatic(mod)
                            || java.lang.reflect.Modifier.isTransient(mod)
                            || f.isSynthetic()) {
                        continue;
                    }
                    if (fieldCount++ >= 24) {
                        break;
                    }
                    f.setAccessible(true);
                    out.put(f.getName(), canon(f.get(v), seen, depth + 1));
                }
                k = k.getSuperclass();
            }
        } catch (Throwable t) {
            // Hostile/inaccessible field — record a typed placeholder, never crash.
            out.put("<error>", "<" + c.getName() + ">");
        }
        if (out.isEmpty()) {
            // No reflective fields (a closure, a lambda, a primitive wrapper already
            // handled above): fall back to a typed toString(), guarded.
            return "<" + c.getSimpleName() + ">";
        }
        return out;
    }

    private static double round(double d) {
        // Trim to microsecond precision to keep the JSON stable across runs.
        return Math.round(d * 1_000_000.0) / 1_000_000.0;
    }

    private static final class Frame {
        String func;
        Object[] args;
        long tEnter;
    }
}
