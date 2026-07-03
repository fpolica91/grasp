package dreplay.agent.recorder;

import java.util.List;
import java.util.Map;

/**
 * Minimal, dependency-free JSON serializer for the Flow recorder.
 *
 * <p>Handles {@code null}, {@code Boolean}, {@code Number}, {@code String},
 * {@code Map} (→ object), {@code List} (→ array). Numbers are emitted verbatim;
 * everything else is stringified and quoted. Doubles that are NaN/Infinite become
 * {@code null} (invalid JSON otherwise).
 *
 * <p>This is intentionally NOT a general-purpose JSON library — it serializes only
 * the canonical shapes {@link FlowRecorder#canon} produces. Kept here so the agent
 * JAR has exactly one runtime dependency (the shaded ASM); pulling in Jackson would
 * balloon the agent and risk version conflicts with the target's classpath.
 */
final class Json {

    static String write(Object root) {
        StringBuilder sb = new StringBuilder(8192);
        write(sb, root);
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static void write(StringBuilder sb, Object v) {
        if (v == null) {
            sb.append("null");
            return;
        }
        if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<Object, Object> e : ((Map<Object, Object>) v).entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                writeString(sb, String.valueOf(e.getKey()));
                sb.append(':');
                write(sb, e.getValue());
            }
            sb.append('}');
            return;
        }
        if (v instanceof List) {
            sb.append('[');
            boolean first = true;
            for (Object item : (List<?>) v) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                write(sb, item);
            }
            sb.append(']');
            return;
        }
        if (v instanceof String) {
            writeString(sb, (String) v);
            return;
        }
        if (v instanceof Boolean) {
            sb.append(((Boolean) v) ? "true" : "false");
            return;
        }
        if (v instanceof Number) {
            if (v instanceof Double) {
                double d = (Double) v;
                if (Double.isNaN(d) || Double.isInfinite(d)) {
                    sb.append("null");
                    return;
                }
            } else if (v instanceof Float) {
                float f = (Float) v;
                if (Float.isNaN(f) || Float.isInfinite(f)) {
                    sb.append("null");
                    return;
                }
            }
            sb.append(v.toString());
            return;
        }
        // Fallback: stringify. canon() should have prevented reaching here.
        writeString(sb, String.valueOf(v));
    }

    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                case '\b': sb.append("\\b");  break;
                case '\f': sb.append("\\f");  break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    private Json() {
    }
}
