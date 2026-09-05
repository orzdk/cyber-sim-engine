'use strict';

const { SCRIPTS } = require('./cards');
const { evalExpr, evalCondition } = require('./eval');
const { matchCard } = require('./filters');

function _discountApplies(b, pid, card) {
  const pd = b._next_play_discount;
  return !!(pd && pd.pid === pid && matchCard(card, pd.filter, b, { self_pid: pid, bindings: {} }));
}

function effectivePlayCost(b, pid, ref, card) {
  let base = card.cost || 0;
  const mod = SCRIPTS[ref.card_id]?.playCostModifier;
  if (mod) {
    const ctx = {
      self_pid: pid, self_iid: ref.iid, self_card_id: ref.card_id,
      bindings: {},
    };
    // Optional gate: when present and false, the whole modifier is skipped —
    // discount AND floor — so the card just costs its printed price
    // (We Gotta Live Together, Nocturne OP55 N1).
    if (!mod.condition || evalCondition(mod.condition, b, ctx)) {
      const discount = Math.max(0, evalExpr(mod.discount, b, ctx));
      base = Math.max(mod.min ?? 1, base - discount);
    }
  }
  if (_discountApplies(b, pid, card)) {
    const pd = b._next_play_discount;
    base = Math.max(pd.min ?? 1, base - pd.discount);
  }
  return base;
}

function consumeNextPlayDiscount(b, pid, card) {
  if (_discountApplies(b, pid, card)) delete b._next_play_discount;
}

module.exports = { effectivePlayCost, consumeNextPlayDiscount };
