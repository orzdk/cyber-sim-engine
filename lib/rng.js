'use strict';

function randFloat(b, tag) {
  const map = b?._rngMap;
  if (map && tag in map) return map[tag];
  let v;
  if (b?._rngState !== undefined) {
    b._rngState = (b._rngState + 0x6D2B79F5) | 0;
    let t = Math.imul(b._rngState ^ b._rngState >>> 15, 1 | b._rngState);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    v = ((t ^ t >>> 14) >>> 0) / 4294967296;
  } else {
    v = Math.random();
  }
  if (map && tag !== undefined) map[tag] = v;
  return v;
}

function shuffle(b, arr) {
  const a = [...arr];
  const seq = b ? b._rng_seq++ : undefined;
  for (let i = a.length - 1; i > 0; i--) {
    const j = 0 | randFloat(b, seq !== undefined ? `s${seq}.${i}` : undefined) * (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { randFloat, shuffle };
