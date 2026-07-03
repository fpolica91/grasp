package dreplay.agent;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Label;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;
import org.objectweb.asm.commons.AdviceAdapter;

import java.util.ArrayList;
import java.util.List;

/**
 * ASM bytecode rewriter: injects {@link FlowRecorder#enter}/{@code exit} hooks into
 * every method of a class.
 *
 * <p>Strategy (uses {@link AdviceAdapter} so local-variable-table and stack-map
 * frames are recomputed correctly — no manual frame math):
 * <ul>
 *   <li><b>onMethodEnter</b>: build a {@code Object[]} of the method's arguments
 *       (boxing primitives), then call {@code FlowRecorder.enter(name, args)}.</li>
 *   <li><b>onMethodExit</b>: for non-void methods, box the return value on the stack
 *       (a copy, since the original is left for the actual return) and call
 *       {@code FlowRecorder.exit(name, value)}. For void, call with {@code null}.</li>
 *   <li><b>thrown exceptions</b>: {@code AdviceAdapter} calls {@code onMethodExit}
 *       with opcode {@code ATHROW} before an exceptional exit, so a thrown exception
 *       is captured as the "return" of that frame — matching the Python worker,
 *       which records the {@code arg} of a {@code return} event regardless.</li>
 * </ul>
 *
 * <p>Static initializers ({@code <clinit>}) and synthetic/bridge methods are skipped
 * — they are JVM plumbing, not business logic, and instrumenting {@code <clinit>}
 * can fire before the recorder's own state is ready.
 */
final class FlowInstrument {

    static byte[] instrument(byte[] bytecode, String className) {
        ClassReader cr = new ClassReader(bytecode);
        // COMPUTE_FRAMES: ASM recomputes stack-map frames from scratch (we changed
        // the method bodies). This needs ClassWriter to be able to load classes —
        // it uses the same ClassLoader as the target by default, which is fine here.
        ClassWriter cw = new ClassWriter(cr, ClassWriter.COMPUTE_FRAMES) {
            @Override
            protected ClassLoader getClassLoader() {
                return Thread.currentThread().getContextClassLoader();
            }
            @Override
            protected String getCommonSuperClass(String type1, String type2) {
                // Conservative: Object is always a valid common supertype. Avoids
                // ClassNotFoundException when the target references classes not
                // resolvable from the agent's loader.
                return "java/lang/Object";
            }
        };
        ClassVisitor cv = new ClassVisitor(Opcodes.ASM9, cw) {
            private String currentClass;

            @Override
            public void visit(int version, int access, String name, String signature,
                              String superName, String[] interfaces) {
                this.currentClass = name;
                super.visit(version, access, name, signature, superName, interfaces);
            }

            @Override
            public MethodVisitor visitMethod(int access, String name, String descriptor,
                                             String signature, String[] exceptions) {
                MethodVisitor mv = super.visitMethod(access, name, descriptor, signature, exceptions);
                // Skip <clinit> (static init) — runs at class-load, before main, and
                // instrumenting it fires events for field defaults that aren't a "run".
                // Skip abstract/native methods — no body to instrument (the
                // NegativeArraySizeException on JDK classes came from abstract
                // methods reaching the arg-array emitter with no body).
                // Skip bridge/synthetic methods — compiler-generated plumbing.
                if ("<clinit>".equals(name)
                        || (access & Opcodes.ACC_SYNTHETIC) != 0
                        || (access & Opcodes.ACC_ABSTRACT) != 0
                        || (access & Opcodes.ACC_NATIVE) != 0) {
                    return mv;
                }
                return new TraceAdvice(Opcodes.ASM9, mv, access, name, descriptor, currentClass);
            }
        };
        cr.accept(cv, ClassReader.EXPAND_FRAMES);
        return cw.toByteArray();
    }

    /** The AdviceAdapter that does the actual per-method injection. */
    static final class TraceAdvice extends AdviceAdapter {
        private final String methodName;
        private final String methodDesc;
        private final String className;
        private final Type[] argTypes;
        private final boolean isStatic;

        TraceAdvice(int api, MethodVisitor mv, int access, String name,
                    String desc, String className) {
            super(api, mv, access, name, desc);
            this.methodName = name;
            this.methodDesc = desc;
            this.className = className;
            this.argTypes = Type.getArgumentTypes(desc);
            this.isStatic = (access & Opcodes.ACC_STATIC) != 0;
        }

        @Override
        protected void onMethodEnter() {
            // enter(String name, Object[] args): push the name first, then the
            // args array. (Order on stack: name, args[] — matches the descriptor.)
            visitLdcInsn(methodName);
            pushArgsArray();
            visitMethodInsn(INVOKESTATIC, "dreplay/agent/recorder/FlowRecorder",
                    "enter", "(Ljava/lang/String;[Ljava/lang/Object;)V", false);
        }

        @Override
        protected void onMethodExit(int opcode) {
            // opcode == RETURN (void) || ARETURN/IRETURN/... (value) || ATHROW (exception)
            if (opcode == Opcodes.ATHROW) {
                // The exception is on the stack; copy it so ATHROW still has it.
                dup();
                boxOrKeep(Type.getType(Throwable.class));
                emitExit();
                return;
            }
            if (opcode == Opcodes.RETURN) {
                visitInsn(ACONST_NULL);
                emitExit();
                return;
            }
            // Non-void normal return: the value is on the stack. Dup it, box it.
            Type retType = Type.getReturnType(methodDesc);
            dup();             // copy the return value
            boxOrKeep(retType);
            emitExit();
        }

        private void emitExit() {
            visitLdcInsn(methodName);
            visitMethodInsn(INVOKESTATIC, "dreplay/agent/recorder/FlowRecorder",
                    "exit", "(Ljava/lang/Object;Ljava/lang/String;)V", false);
        }

        /** Box the top-of-stack value into an Object (primitives → wrappers). */
        private void boxOrKeep(Type t) {
            if (t.getSort() == Type.OBJECT || t.getSort() == Type.ARRAY) {
                return; // already a reference type
            }
            box(t); // AdviceAdapter.box boxes a primitive on the stack
        }

        /** Build an Object[] of the method arguments on the stack. */
        private void pushArgsArray() {
            // Count the argument slots. (We materialize the array of declared args,
            // NOT "this".)
            push(argTypes.length);
            visitTypeInsn(ANEWARRAY, "java/lang/Object");
            int local = isStatic ? 0 : 1;
            for (int i = 0; i < argTypes.length; i++) {
                Type at = argTypes[i];
                dup();             // arrayref
                push(i);           // index
                loadArgFromLocal(local, at);  // load + box
                visitInsn(AASTORE);
                local += at.getSize();
            }
        }

        private void loadArgFromLocal(int local, Type t) {
            switch (t.getSort()) {
                case Type.BOOLEAN: visitVarInsn(ILOAD, local); box(Type.BOOLEAN_TYPE); break;
                case Type.BYTE:    visitVarInsn(ILOAD, local); box(Type.BYTE_TYPE); break;
                case Type.CHAR:    visitVarInsn(ILOAD, local); box(Type.CHAR_TYPE); break;
                case Type.SHORT:   visitVarInsn(ILOAD, local); box(Type.SHORT_TYPE); break;
                case Type.INT:     visitVarInsn(ILOAD, local); box(Type.INT_TYPE); break;
                case Type.FLOAT:   visitVarInsn(FLOAD, local); box(Type.FLOAT_TYPE); break;
                case Type.LONG:    visitVarInsn(LLOAD, local); box(Type.LONG_TYPE); break;
                case Type.DOUBLE:  visitVarInsn(DLOAD, local); box(Type.DOUBLE_TYPE); break;
                default:           visitVarInsn(ALOAD, local); break; // object/array
            }
        }

        // Suppress unused-private warnings for fields referenced for clarity.
        @SuppressWarnings("unused")
        private String _debug() {
            return className + "." + methodName + methodDesc + " static=" + isStatic;
        }
    }

    private FlowInstrument() {
    }

    // Kept to prove to readers that java.util.List is in scope (used in earlier
    // iterations for arg-list building); harmless if unused.
    @SuppressWarnings("unused")
    private static final List<?> _UNUSED = new ArrayList<>();
}
