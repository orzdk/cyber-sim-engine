'use strict';

const { DB } = require('./cards');
const { shuffle } = require('./rng');
const { traceInit } = require('./trace');
const { OPENING_HAND_SIZE, DECK_MIN_CARDS, DECK_MAX_CARDS, LEGEND_COUNT } = require('./constants');

function emptyZones(id) {
  return {
    hand: [], deck: [], trash: [], removed: [],
    legends: [], eddies: [], field: [],
    fixer: [4,6,8,10,12,20].map(s => ({ iid: `${id}_d${s}`, sides: s, value: 0 })),
    gigs: [],
  };
}

function createBoard() {
  const mp = id => ({
    id, zones: emptyZones(id),
    called_legend_this_turn: false,
    sold_card_this_turn: false,
    called_legend_defensive_this_turn: false,
    tapped: [],
    took_gig_this_turn: false,
  });
  const b = {
    p1: mp('p1'), p2: mp('p2'),
    turn_number: 0, active_player: 'p1', first_player: 'p1',
    phase: 'between_turns',
    current_attack: null, effect_stack: [], scheduled_effects: [],
    rate_limits: { p1: {}, p2: {} },
    overtime: false, winner: null, _next_iid: 1,
    _rng_seq: 0, _rngMap: null,
  };
  traceInit(b);
  return b;
}

function legendBaseName(c) {
  const sub = c.subname;
  return sub && c.name.endsWith(`: ${sub}`) ? c.name.slice(0, -(sub.length + 2)) : c.name;
}

function expandDeck(deckDef) {
  const ids = [];
  for (const { card_id, count } of deckDef.cards)
    for (let i = 0; i < count; i++) ids.push(card_id);
  return ids;
}

function validateDeck(deckDef) {
  const { legends = [], cards = [] } = deckDef;
  const errors = [], warnings = [];

  if (legends.length !== LEGEND_COUNT)
    errors.push(`Need exactly ${LEGEND_COUNT} legends, found ${legends.length}`);

  const legendNames = new Set();
  let dupLegendNames = false;
  for (const id of legends) {
    const c = DB[id];
    if (!c) { errors.push(`Unknown legend card "${id}"`); continue; }
    if (c.type !== 'Legend') { errors.push(`"${c.name}" is not a Legend`); continue; }
    const base = legendBaseName(c);
    if (legendNames.has(base)) {
      errors.push(`Two Legends named "${base}" — Legends must have different names`);
      dupLegendNames = true;
    }
    legendNames.add(base);
  }

  let total = 0;
  let overCopies = false;
  for (const { card_id, count } of cards) {
    const c = DB[card_id];
    if (!c) { errors.push(`Unknown card "${card_id}"`); continue; }
    if (c.type === 'Legend') errors.push(`"${c.name}" must be in legends list, not deck`);
    if (count > 3) { errors.push(`"${c.name}": ${count} copies (max 3)`); overCopies = true; }
    total += count;
  }

  if (total < DECK_MIN_CARDS) errors.push(`${total} deck cards (min ${DECK_MIN_CARDS})`);
  if (total > DECK_MAX_CARDS) errors.push(`${total} deck cards (max ${DECK_MAX_CARDS})`);

  const ramPool = {};
  for (const id of legends) {
    const c = DB[id];
    if (!c) continue;
    const color = c.color?.toLowerCase();
    if (color) ramPool[color] = (ramPool[color] || 0) + (c.ram || 0);
  }
  let ramInvalid = false;
  for (const { card_id } of cards) {
    const c = DB[card_id];
    if (!c) continue;
    const color = c.color?.toLowerCase();
    const ram   = c.ram || 0;
    if (!color) { warnings.push(`"${c.name}" has no color — skipping RAM check`); continue; }
    if (!(color in ramPool)) { ramInvalid = true; continue; }
    const pool = ramPool[color] || 0;
    if (ram > pool) { warnings.push(`"${c.name}" needs ${ram} ${color} RAM but legends only provide ${pool}`); ramInvalid = true; }
  }

  return { errors, warnings, total, ramInvalid, legendCount: legends.length, overCopies, dupLegendNames };
}

function deckIsIllegal(deckDef) {
  const { total, ramInvalid, legendCount, overCopies, dupLegendNames } = validateDeck(deckDef);
  return total < DECK_MIN_CARDS || total > DECK_MAX_CARDS ||
         ramInvalid || legendCount !== 3 || overCopies || dupLegendNames;
} 
function setupGame(p1DeckDef, p2DeckDef, firstPlayer = 'p1', opts = {}) {
  const b = createBoard();
  b.first_player = firstPlayer;
  if (opts.seed !== undefined) b._rngState = opts.seed | 0;

  const preShuffled = opts.preShuffled || null;

  const makeZones = (id, deckDef, pre) => {
    const z = emptyZones(id);
    if (pre) {
      const handCards = pre.hand    || [];
      const deckCards = pre.deck    || [];
      const legCards  = pre.legends || deckDef.legends;
      z.deck    = [...handCards, ...deckCards].map(cid => ({ iid: String(b._next_iid++), card_id: cid }));
      z.legends = legCards.map(cid => ({
        iid: String(b._next_iid++), card_id: cid, state: 'ready', face: 'face_down', equipped_gear: [],
      }));

      b._rng_seq += 2;
    } else {
      z.deck    = shuffle(b, expandDeck(deckDef)).map(cid => ({ iid: String(b._next_iid++), card_id: cid }));
      z.legends = shuffle(b, deckDef.legends).map(cid => ({
        iid: String(b._next_iid++), card_id: cid, state: 'ready', face: 'face_down', equipped_gear: [],
      }));
    }
    return z;
  };

  b.p1.zones = makeZones('p1', p1DeckDef, preShuffled?.p1);
  b.p2.zones = makeZones('p2', p2DeckDef, preShuffled?.p2);

  if (b[firstPlayer].zones.legends[0]) b[firstPlayer].zones.legends[0].state = 'spent';
  if (b[firstPlayer].zones.legends[1]) b[firstPlayer].zones.legends[1].state = 'spent';

  for (let i = 0; i < OPENING_HAND_SIZE; i++) {
    b.p1.zones.hand.push(b.p1.zones.deck.shift());
    b.p2.zones.hand.push(b.p2.zones.deck.shift());
  }

  b.active_player = firstPlayer;
  b.phase = 'between_turns';
  return b;
}

module.exports = { validateDeck, deckIsIllegal, setupGame };
