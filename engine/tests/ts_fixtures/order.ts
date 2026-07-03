// Conformance fixture for the TypeScript FLOW-mode adapter (spec §2, §8.8).
//
// A small, dependency-free business flow: charge() calls label() (an interior
// helper) and returns an object built from the input + a module constant. The TS
// type system is exercised throughout: an `interface`, a `type` alias, typed
// params/returns, a typed const, and a typed local inside the body. This is the
// surface the adapter must (a) type-strip to JS, (b) AST-trace for REAL interior
// nodes, and (c) read for the domain vocabulary (id/amount/currency/tag/ok/total).
//
// Kept simple-typed (single-token types: string/number/Order/Result) so the regex
// fallback path can also lower it when the `typescript` npm module is absent.

/** A business object — its fields ARE the domain vocabulary. */
interface Order {
  id: string;
  amount: number;
  currency: string;
}

/** The operation result — also vocabulary. */
type Result = { ok: boolean; tag: string; total: number };

/** A module constant (observed by the tracer). */
const FEE: number = 2;

/** Interior helper — its call must be observed as a traced node. */
function label(x: number): string {
  return x > 0 ? "pos" : "neg";
}

/** The entrypoint. Calls label() and returns a Result. */
function charge(o: Order): Result {
  const total: number = o.amount + FEE;
  return { ok: o.amount > 0, tag: label(o.amount), total: total };
}

module.exports = { charge };
