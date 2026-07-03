function classify(n) { return { label: n < 0 ? "neg" : "pos", abs: Math.abs(n) }; }
module.exports = { classify };
