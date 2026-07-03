function classify(n) { return { label: n <= 0 ? "neg" : "pos", abs: Math.abs(n) }; }  // boundary moved at 0
module.exports = { classify };
