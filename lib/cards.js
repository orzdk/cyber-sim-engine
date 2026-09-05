'use strict';

const CARDS        = require('../data/cards.json');
const CARD_SCRIPTS = require('../data/card_scripts.json');

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const DB = {};
for (const c of CARDS) DB[c.number] = deepFreeze(c);
Object.freeze(DB);

const SCRIPTS = {};
for (const s of CARD_SCRIPTS) SCRIPTS[s.card_id] = deepFreeze(s);
Object.freeze(SCRIPTS);

Object.freeze(CARDS);
Object.freeze(CARD_SCRIPTS);

module.exports = { DB, SCRIPTS, CARDS, CARD_SCRIPTS };
