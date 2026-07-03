package dreplay.agent;

import java.lang.instrument.Instrumentation;
import java.lang.instrument.ClassFileTransformer;
import java.security.ProtectionDomain;

import dreplay.agent.recorder.FlowRecorder;

/**
 * The dreplay flow-tracing -javaagent for the JVM.
 *
 * <p>This is the tracer MECHANISM for the Java/JVM flow-comprehension adapter
 * (see {@code dreplay/adapter/java_flow.py}). It is packaged into a JAR whose
 * manifest declares {@code Premain-Class: dreplay.agent.FlowAgent}. The Python
 * adapter launches the target as:
 *
 * <pre>
 *   java -javaagent:dreplay-agent.jar=targetPkg=org.example -cp ... MainClass
 * </pre>
 *
 * <p>Mechanism (bytecode instrumentation via ASM): a {@link ClassFileTransformer}
 * rewrites the bytecode of classes whose binary name starts with the configured
 * target package. For each method it injects, via ASM's {@code AdviceAdapter}:
 * <ul>
 *   <li>an <b>onMethodEnter</b> call to {@link FlowRecorder#enter} that snapshots
 *       the method name + its arguments (the observed {@code locals});</li>
 *   <li>an <b>onMethodExit</b> call to {@link FlowRecorder#exit} that records the
 *       returned value (or {@code null} for void); on a thrown exception the
 *       recorder catches it via a try/finally injected around the body.</li>
 * </ul>
 *
 * <p>HONESTY RULE (dreplay docs/what-this-is.md §1, principle #1 — observed, never
 * guessed): every value in the emitted JSON is a value the code actually produced
 * (an argument passed, a value returned, a thrown throwable). Nothing is inferred.
 * A method the trace cannot see is not synthesized; {@link FlowRecorder} emits only
 * the events it observed.
 *
 * <p>The agent emits the Flow JSON protocol to <b>stdout</b> on JVM shutdown via a
 * shutdown hook. It uses {@code System.err} for its own diagnostics so it never
 * corrupts the JSON on stdout. {@code com.fasterxml.jackson} is NOT a dependency —
 * JSON is hand-built from the canonical shapes to keep the agent dependency-free
 * (only the shaded ASM).
 *
 * <p>Agent arguments: a single key=value pair {@code targetPkg=<prefix>}. Only
 * classes whose name starts with the prefix are instrumented (the relevance layer
 * starts narrow — framework/plumbing bytecde is never traced, matching the Python
 * instrument's target-dir scoping).
 */
public final class FlowAgent {

    /** Agent entry point (loaded before main). */
    public static void premain(String agentArgs, Instrumentation inst) {
        String targetPkg = "";
        if (agentArgs != null) {
            for (String pair : agentArgs.split(",")) {
                int eq = pair.indexOf('=');
                if (eq > 0 && pair.substring(0, eq).trim().equals("targetPkg")) {
                    targetPkg = pair.substring(eq + 1).trim();
                }
            }
        }
        final String prefix = targetPkg;
        // Make sure the recorder flushes its JSON exactly once, after main returns.
        Runtime.getRuntime().addShutdownHook(new Thread(FlowRecorder::flush, "dreplay-flow-flush"));
        inst.addTransformer(new ClassFileTransformer() {
            @Override
            public byte[] transform(ClassLoader loader, String className,
                                    Class<?> classBeingRedefined,
                                    ProtectionDomain protectionDomain,
                                    byte[] classfileBuffer) {
                if (className == null) {
                    return null;
                }
                String dotted = className.replace('/', '.');
                // NEVER touch the JDK / agent internals — instrumenting bootstrap
                // classes breaks JVM startup (recursion during their own init, and
                // the recorder's classes aren't loaded yet). Only the target's OWN
                // classes are in scope.
                if (dotted.startsWith("java.") || dotted.startsWith("javax.")
                        || dotted.startsWith("sun.") || dotted.startsWith("jdk.")
                        || dotted.startsWith("com.sun.") || dotted.startsWith("javax.")
                        || dotted.startsWith("org.w3c.") || dotted.startsWith("org.xml.")
                        || dotted.startsWith("dreplay.agent")) {
                    return null;
                }
                // Scope: only the target package. An empty prefix means "instrument
                // everything reachable from this transformer" — used only by the
                // conformance test where the whole classpath is the target. With the
                // JDK exclusions above, that means the target's own classes only.
                if (!prefix.isEmpty() && !dotted.startsWith(prefix)) {
                    return null;
                }
                try {
                    return FlowInstrument.instrument(classfileBuffer, dotted);
                } catch (Throwable t) {
                    // Instrumentation must never break the target program: if a class
                    // can't be rewritten, leave it byte-for-byte intact (observed run
                    // with fewer interior nodes beats a crash with none).
                    System.err.println("[dreplay] instrumentation skipped " + dotted
                            + ": " + t);
                    return null;
                }
            }
        }, true);
    }

    private FlowAgent() {
    }
}
