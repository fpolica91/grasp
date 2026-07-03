package org.example;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * dreplay Java FLOW conformance fixture.
 *
 * A small but realistic business flow, intentionally dependency-free so it compiles
 * under a bare javac (no Maven/Gradle needed). ``main`` receives the dreplay kwargs
 * as a single JSON-array positional arg (args[0]), decodes element 0 into an Order,
 * and runs it through ``classify`` — which calls the interior helper ``tag``.
 *
 * The dreplay -javaagent instruments every method in org.example, so the emitted
 * Flow JSON carries REAL interior nodes (classify → tag), observed operands
 * (arg bindings, the Order's fields), and a return value. The conformance test
 * asserts those against the Flow the Python adapter reduces.
 *
 * The JSON parser below is minimal but correct for object/array/string/number/bool/
 * null — enough to decode the canonical shapes the fuzzer produces, and to keep
 * this fixture free of any third-party dependency.
 */
public class Classifier {

    /** The business object. A POJO: its fields ARE the vocab (owner, amount, status). */
    public static class Order {
        public String owner;
        public double amount;
        public String status;

        public Order(String owner, double amount, String status) {
            this.owner = owner;
            this.amount = amount;
            this.status = status;
        }
    }

    /** Interior helper: turns an amount into a tag. Traced as an interior node. */
    public static String tag(double amount) {
        if (amount >= 100) return "big";
        return "small";
    }

    /** The business entrypoint: classifies an order. Calls tag() internally. */
    public static Map<String, Object> classify(Order order) {
        String label = tag(order.amount);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("owner", order.owner);
        result.put("tag", label);
        result.put("ok", true);
        return result;
    }

    /** dreplay entrypoint. args[0] = JSON array of the kwargs values. */
    public static void main(String[] args) {
        if (args.length == 0) {
            System.err.println("no input");
            return;
        }
        Object parsed = Json.parse(args[0]);
        // Element 0 of the kwargs-values array is the order object.
        Object first = parsed;
        if (parsed instanceof java.util.List && !((java.util.List<?>) parsed).isEmpty()) {
            first = ((java.util.List<?>) parsed).get(0);
        }
        Map<String, Object> obj = (Map<String, Object>) first;
        Order order = new Order(
                (String) obj.get("owner"),
                ((Number) obj.get("amount")).doubleValue(),
                obj.containsKey("status") ? (String) obj.get("status") : "new"
        );
        Map<String, Object> result = classify(order);
        // Print to stderr so it doesn't corrupt the agent's stdout JSON.
        System.err.println("RESULT owner=" + result.get("owner") + " tag=" + result.get("tag"));
    }

    // ------------------------------------------------------------------ //
    // Minimal JSON parser (dependency-free). Handles the canonical shapes
    // the dreplay fuzzer emits: object/array/string/number/bool/null.
    // ------------------------------------------------------------------ //
    static final class Json {
        private final String s;
        private int i;

        private Json(String s) {
            this.s = s;
            this.i = 0;
        }

        static Object parse(String s) {
            Json p = new Json(s);
            p.skip();
            return p.value();
        }

        private Object value() {
            skip();
            char c = s.charAt(i);
            switch (c) {
                case '{': return object();
                case '[': return array();
                case '"': return string();
                case 't': case 'f': return bool();
                case 'n': i += 4; return null;
                default: return number();
            }
        }

        private Map<String, Object> object() {
            Map<String, Object> m = new LinkedHashMap<>();
            i++; skip(); // {
            if (s.charAt(i) == '}') { i++; return m; }
            while (true) {
                skip();
                String k = string();
                skip(); i++; skip(); // :
                Object v = value();
                m.put(k, v);
                skip();
                char c = s.charAt(i++);
                if (c == '}') break;
                // c == ','
                skip();
            }
            return m;
        }

        private java.util.List<Object> array() {
            java.util.List<Object> a = new java.util.ArrayList<>();
            i++; skip(); // [
            if (s.charAt(i) == ']') { i++; return a; }
            while (true) {
                a.add(value());
                skip();
                char c = s.charAt(i++);
                if (c == ']') break;
                skip();
            }
            return a;
        }

        private String string() {
            StringBuilder sb = new StringBuilder();
            i++; // "
            while (s.charAt(i) != '"') {
                char c = s.charAt(i++);
                if (c == '\\') {
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'n': sb.append('\n'); break;
                        case 't': sb.append('\t'); break;
                        case 'r': sb.append('\r'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'u':
                            sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                            i += 4;
                            break;
                        default: sb.append(e);
                    }
                } else {
                    sb.append(c);
                }
            }
            i++; // "
            return sb.toString();
        }

        private Object number() {
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) {
                i++;
            }
            String n = s.substring(start, i);
            if (n.contains(".") || n.contains("e") || n.contains("E")) {
                return Double.parseDouble(n);
            }
            return Long.parseLong(n);
        }

        private Boolean bool() {
            if (s.charAt(i) == 't') { i += 4; return Boolean.TRUE; }
            i += 5; return Boolean.FALSE;
        }

        private void skip() {
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    i++;
                } else {
                    break;
                }
            }
        }
    }
}
