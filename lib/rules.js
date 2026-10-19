'use strict';

const { act, def } = require('./board');
const { effectiveKeywords } = require('./events');
const { WIN_GIG_COUNT } = require('./constants');

function canUnitAttack(u, b, pid) {
  if (u.state !== 'ready') return false;
  const kw = effectiveKeywords(b, pid, u);
  if (kw.includes('CANNOT_ATTACK')) return false;
  if (u.entered_play_turn === b.turn_number) {
    if (kw.includes('NO_HASTE')) return false;
    if (!kw.includes('GO_SOLO') && !kw.includes('HASTE_VS_SPENT') && !kw.includes('ADRENALINE') &&
        !kw.includes('HASTE_VS_GIGS')) return false;
  }
  return true;
}

function attackableUnits(b) {
  return act(b).zones.field.filter(u => canUnitAttack(u, b, b.active_player));
}

function legalAttackTargets(b, u, pid) {
  const kw = effectiveKeywords(b, pid, u);
  const enteredThisTurn = u.entered_play_turn === b.turn_number;
  const dpid = b.active_player === 'p1' ? 'p2' : 'p1';
  let unit_iids = def(b).zones.field.filter(x => x.state === 'spent').map(x => x.iid);
  if (kw.includes('ATTACK_READY_UNITS'))
    unit_iids = unit_iids.concat(def(b).zones.field
      .filter(x => x.state === 'ready')
      .map(x => x.iid));
  else if (kw.includes('ATTACK_READY_BLOCKERS'))
    unit_iids = unit_iids.concat(def(b).zones.field
      .filter(x => x.state === 'ready' && hasBlocker(x, b, dpid))
      .map(x => x.iid));
  let gigs = !kw.includes('CANNOT_ATTACK_GIGS');
  if (enteredThisTurn) {
    if (kw.includes('HASTE_VS_SPENT')) gigs = false;
    if (kw.includes('HASTE_VS_GIGS') &&
        !kw.includes('GO_SOLO') && !kw.includes('ADRENALINE') && !kw.includes('HASTE_VS_SPENT'))
      unit_iids = [];
  }
  return { gigs, unit_iids };
}

function hasAttackTarget(b, u, pid) {
  const t = legalAttackTargets(b, u, pid);
  return t.gigs || t.unit_iids.length > 0;
}

function hasBlocker(u, b, pid) {
  return effectiveKeywords(b, pid, u).includes('BLOCKER');
}


function checkWin(b) {
  if (b.overtime) {
    const p1 = b.p1.zones.gigs.length, p2 = b.p2.zones.gigs.length, t = p1 + p2;
    if (p1 > t / 2) return 'p1';
    if (p2 > t / 2) return 'p2';
    return null;
  }
  if (b[b.active_player].zones.gigs.length >= WIN_GIG_COUNT) return b.active_player;
  return null;
}

module.exports = {
  canUnitAttack, attackableUnits, hasBlocker,
  legalAttackTargets, hasAttackTarget,
  checkWin,
};
