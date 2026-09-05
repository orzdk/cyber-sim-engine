'use strict';

const { trace } = require('./trace');

const opponent    = pid => (pid === 'p1' ? 'p2' : 'p1');
const streetCred  = p   => p.zones.gigs.reduce((s, d) => s + d.value, 0);

function rlKey(scopeIid, event) { return `${scopeIid}::${event}`; }

function rateLimitScopeId(trigger, ref) {
  switch (trigger.rate_limit_scope) {
    case 'iid':        return ref.iid;
    case 'card_id':    return ref.card_id;
    case 'controller': return `__controller__:${ref.card_id}`;
    default:           return undefined;
  }
}

function findOnBoard(b, pid, iid) {
  return b[pid].zones.field.find(u => u.iid === iid) ||
         b[pid].zones.legends.find(l => l.iid === iid) || null;
}

function findHostOfGear(b, pid, gearIid) {
  for (const host of [...b[pid].zones.field, ...b[pid].zones.legends]) {
    if ((host.equipped_gear || []).some(g => g.iid === gearIid)) return host;
  }
  return null;
}

// A gear piece by iid, wherever it is equipped — lets a gear resolve `from_self`
// (findOnBoard only walks field + legends).
function findEquippedGear(b, pid, gearIid) {
  for (const host of [...b[pid].zones.field, ...b[pid].zones.legends]) {
    const g = (host.equipped_gear || []).find(x => x.iid === gearIid);
    if (g) return g;
  }
  return null;
}

function hasFaction(card, faction) {
  return (card.subtype || '').split(', ').map(s => s.trim()).includes(faction);
}

function readyAll(b, pid) {
  const { effectiveKeywords } = require('./events');
  const p = b[pid];
  p.zones.legends.forEach(l => l.state = 'ready');
  p.zones.eddies.forEach(e  => e.state = 'ready');
  p.zones.field.forEach(u   => {
    if (!effectiveKeywords(b, pid, u).includes('CANNOT_READY')) u.state = 'ready';
    delete u._temp_power;
    delete u._temp_power_when;
    delete u._temp_keywords;
    delete u._peeked;
    delete u._steal_mod;
  });
  p.tapped = [];
}


function spendTapped(p, amount) {
  if (p.tapped.length < amount)
    throw new Error(`Need ${amount} tapped resource(s) — currently ${p.tapped.length} tapped`);
  const toSpend = p.tapped.splice(0, amount);
  const spentLegends = [];
  for (const iid of toSpend) {
    const e = p.zones.eddies.find(x => x.iid === iid);
    if (e) { e.state = 'spent'; continue; }
    const l = p.zones.legends.find(x => x.iid === iid);
    if (l) { l.state = 'spent'; spentLegends.push(l); }
  }
  p.tapped = [];
  return spentLegends;
}


function legendSpendable(l) {
  const { DB } = require('./cards');
  return l.face !== 'face_up' || !!DB[l.card_id]?.eddie;
}

function readyPool(p, excludeIid = null) {
  const ready = c => c.state === 'ready' && (excludeIid == null || c.iid !== excludeIid);
  return p.zones.eddies.filter(ready).length +
         p.zones.legends.filter(l => ready(l) && legendSpendable(l)).length;
}

function spendEddies(p, amount, excludeIid = null) {
  const ready = c => c.state === 'ready' && (excludeIid == null || c.iid !== excludeIid);
  if (readyPool(p, excludeIid) < amount) return false;
  let rem = amount;
  const spentLegends = [];
  for (const e of p.zones.eddies)  { if (!rem) break; if (ready(e)) { e.state = 'spent'; rem--; } }
  for (const l of p.zones.legends) {
    if (!rem) break;
    if (ready(l) && legendSpendable(l)) { l.state = 'spent'; rem--; spentLegends.push(l); }
  }
  return spentLegends;
}

function hasTriggered(b, pid, scopeIid, event) {
  return !!(b.rate_limits[pid]?.[rlKey(scopeIid, event)]);
}

function markTriggered(b, pid, scopeIid, event) {
  b.rate_limits[pid] = b.rate_limits[pid] || {};
  b.rate_limits[pid][rlKey(scopeIid, event)] = true;
}

function findGigOwner(b, iid) {
  if (b.p1.zones.gigs.some(g => g.iid === iid)) return 'p1';
  if (b.p2.zones.gigs.some(g => g.iid === iid)) return 'p2';
  return null;
}

function _mutateGig(b, iid, fn, label) {
  const pid = findGigOwner(b, iid);
  if (!pid) { trace(b, `T${b.turn_number}/warn gig #${iid} not found for ${label}`); return null; }
  const d = b[pid].zones.gigs.find(g => g.iid === iid);
  const prev = d.value;
  const next = fn(prev);
  // A Gig only takes values on its own faces, and never the value it already
  // has — anything else and the effect fails, leaving the die untouched.
  if (next < 1 || next > d.sides || next === prev) {
    trace(b, `T${b.turn_number}/gig ${pid}#${iid} ${label} failed (${prev}->${next} on d${d.sides})`);
    return { pid, die: d, prev };
  }
  d.value = next;
  trace(b, `T${b.turn_number}/gig ${pid}#${iid} ${label} ${prev}->${d.value}d${d.sides}`);
  return { pid, die: d, prev };
}

function increaseGig(b, iid, n) { return _mutateGig(b, iid, v => v + n, `+${n}`); }
function decreaseGig(b, iid, n) { return _mutateGig(b, iid, v => v - n, `-${n}`); }
function adjustGig  (b, iid, d) { return _mutateGig(b, iid, v => v + d, `adj${d}`); }
function setGigValue(b, iid, v) { return _mutateGig(b, iid, _ => v,     `set=${v}`); }

// Only a draw decks you out — milling and searching move or reveal cards
// without drawing them, so they never trigger this.
function draw(b, pid, n = 1) {
  for (let i = 0; i < n; i++) {
    if (b[pid].zones.deck.length === 0) {
      if (!b.winner) {
        b.winner = opponent(pid);
        trace(b, `T${b.turn_number}/deckout ${pid} drew from an empty deck`);
      }
      return;
    }
    b[pid].zones.hand.push(b[pid].zones.deck.shift());
  }
}

function discardHandTop(b, pid, n = 1) {
  for (let i = 0; i < n && b[pid].zones.hand.length > 0; i++)
    b[pid].zones.trash.push(b[pid].zones.hand.pop());
}

function discardHandIid(b, pid, iid) {
  const idx = b[pid].zones.hand.findIndex(r => r.iid === iid);
  if (idx !== -1) b[pid].zones.trash.push(b[pid].zones.hand.splice(idx, 1)[0]);
}

function mill(b, pid, n = 1) {
  const milled = [];
  for (let i = 0; i < n && b[pid].zones.deck.length > 0; i++) {
    const ref = b[pid].zones.deck.shift();
    b[pid].zones.trash.push(ref);
    milled.push(ref);
  }
  return milled;
}

function recoverIid(b, pid, iid) {
  const idx = b[pid].zones.trash.findIndex(r => r.iid === iid);
  if (idx === -1) return null;
  const [card] = b[pid].zones.trash.splice(idx, 1);
  b[pid].zones.hand.push(card);
  return card;
}

function spendAsset(b, pid, iid) {
  const u = findOnBoard(b, pid, iid);
  if (u) u.state = 'spent';
}

function readyAsset(b, pid, iid) {
  const u = findOnBoard(b, pid, iid);
  if (u) u.state = 'ready';
}

// `when` (a WhenSpec) makes the bonus conditional — it lands in a parallel list
// that applyStaticPower gates per power read, instead of the flat _temp_power.
function addTempPower(b, pid, iid, n, when) {
  const u = findOnBoard(b, pid, iid);
  if (!u) return;
  if (when) (u._temp_power_when = u._temp_power_when || []).push({ n, when });
  else u._temp_power = (u._temp_power || 0) + n;
}

function grantTempKeyword(b, pid, iid, keyword, until) {
  const u = findOnBoard(b, pid, iid);
  if (!u) return;
  const kw = String(keyword).toUpperCase();
  if (until && until.pid && typeof until.turn === 'number') {
    u._until_keywords = u._until_keywords || [];
    if (!u._until_keywords.some(e => e.kw === kw && e.until_pid === until.pid && e.until_turn === until.turn))
      u._until_keywords.push({ kw, until_pid: until.pid, until_turn: until.turn });
    return;
  }
  u._temp_keywords = u._temp_keywords || [];
  if (!u._temp_keywords.includes(kw)) u._temp_keywords.push(kw);
}

function clearExpiredUntilKeywords(b, pid) {
  const turn = b.turn_number;
  if (b._steal_power_limits) {
    b._steal_power_limits = b._steal_power_limits
      .filter(e => !(e.until_pid === pid && turn >= e.until_turn));
    if (b._steal_power_limits.length === 0) delete b._steal_power_limits;
  }
  for (const ownerPid of ['p1', 'p2']) {
    for (const u of [...b[ownerPid].zones.field, ...b[ownerPid].zones.legends]) {
      if (!u._until_keywords) continue;
      u._until_keywords = u._until_keywords.filter(e => !(e.until_pid === pid && turn >= e.until_turn));
      if (u._until_keywords.length === 0) delete u._until_keywords;
    }
  }
}

function scheduleDefeat(b, pid, iid, sourceCardId, condition) {
  if (!b.scheduled_effects.some(e => e.kind === 'defeat_eot' && e.iid === iid))
    b.scheduled_effects.push({ kind: 'defeat_eot', pid, iid, source_card_id: sourceCardId || null, condition: condition || null });
}

function _pushWithGear(b, pid, card, dest) {
  for (const g of (card.equipped_gear || []))
    b[pid].zones[dest].push({ iid: g.iid, card_id: g.card_id });
  b[pid].zones[dest].push({ iid: card.iid, card_id: card.card_id });
}

function _relocateFromField(b, pid, iid, destZone) {
  const idx = b[pid].zones.field.findIndex(u => u.iid === iid);
  if (idx === -1) return null;
  const [u] = b[pid].zones.field.splice(idx, 1);
  _pushWithGear(b, pid, u, u.from_solo ? 'removed' : destZone);
  return u;
}

function returnToHand(b, pid, iid)        { _relocateFromField(b, pid, iid, 'hand'); }
function bottomDeckFromField(b, pid, iid) { _relocateFromField(b, pid, iid, 'deck'); }
function defeatUnit(b, pid, iid)          { return _relocateFromField(b, pid, iid, 'trash'); }

function removeFromGame(b, pid, iid) {
  for (const zone of ['field', 'hand', 'legends', 'eddies']) {
    const idx = b[pid].zones[zone].findIndex(c => c.iid === iid);
    if (idx !== -1) {
      const [card] = b[pid].zones[zone].splice(idx, 1);
      _pushWithGear(b, pid, card, 'removed');
      return;
    }
  }
}

function defeatGear(b, pid, gearIid) {
  const host = findHostOfGear(b, pid, gearIid);
  if (!host) return;
  const idx = host.equipped_gear.findIndex(g => g.iid === gearIid);
  if (idx === -1) return;
  const [g] = host.equipped_gear.splice(idx, 1);
  b[pid].zones.trash.push({ iid: g.iid, card_id: g.card_id });
}

function equipGear(b, pid, gearRef, targetIid) {
  const target = b[pid].zones.field.find(u => u.iid === targetIid) ||
                 b[pid].zones.legends.find(l => l.iid === targetIid && l.face === 'face_up');
  if (!target) return false;
  target.equipped_gear = target.equipped_gear || [];
  target.equipped_gear.push({ iid: gearRef.iid, card_id: gearRef.card_id });
  return true;
}

function transferGig(b, gigIid, toPid) {
  const fromPid = findGigOwner(b, gigIid);
  if (!fromPid || fromPid === toPid) return null;
  const idx = b[fromPid].zones.gigs.findIndex(g => g.iid === gigIid);
  const [g] = b[fromPid].zones.gigs.splice(idx, 1);
  b[toPid].zones.gigs.push(g);
  return g;
}

function countBoardRefs(b) {
  let n = 0;
  for (const pid of ['p1', 'p2']) {
    const z = b[pid].zones;
    for (const zone of ['hand', 'deck', 'trash', 'removed', 'eddies', 'fixer', 'gigs'])
      n += (z[zone] || []).length;
    for (const u of z.field)   n += 1 + (u.equipped_gear || []).length;
    for (const l of z.legends) n += 1 + (l.equipped_gear || []).length;
  }
  return n;
}

function clearTransients(b) {
  for (const pid of ['p1', 'p2']) {
    for (const u of [...b[pid].zones.field, ...b[pid].zones.legends]) {
      delete u._temp_power;
      delete u._temp_power_when;
      delete u._temp_keywords;
      delete u._peeked;
      delete u._combat_this_turn;
      delete u._stole_gig_this_turn;
      delete u._steal_mod;
      delete u._solo_discount;

      if (u._must_attack_on !== undefined && b.turn_number >= u._must_attack_on) delete u._must_attack_on;
    }
    delete b[pid]._played_program_this_turn;
  }
  delete b._next_play_discount;
  delete b._fight_shield;
  delete b._pending_defeats;
  delete b._pending_steal;
  delete b._steal_pending;
  delete b.badges;
}

function recordTurnEndAndCheckOvertime(b) {
  const ap = b[b.active_player];
  ap._skipped_gig_last_turn = !ap.took_gig_this_turn;
  if (!b.overtime &&
      b.p1._skipped_gig_last_turn === true &&
      b.p2._skipped_gig_last_turn === true) {
    b.overtime = true;
  }
}

module.exports = {
  opponent, streetCred, findOnBoard, findHostOfGear, findEquippedGear,
  hasFaction,
  readyAll, spendTapped, draw, spendEddies, readyPool, legendSpendable,
  hasTriggered, markTriggered, rateLimitScopeId,
  increaseGig, decreaseGig, adjustGig, setGigValue, transferGig, findGigOwner,
  discardHandTop, discardHandIid, mill, recoverIid,
  spendAsset, readyAsset, addTempPower, grantTempKeyword, clearExpiredUntilKeywords, scheduleDefeat,
  returnToHand, bottomDeckFromField, removeFromGame,
  defeatUnit, defeatGear, equipGear,
  countBoardRefs,
  clearTransients,
  recordTurnEndAndCheckOvertime,
};
