'use strict';

const { DB, SCRIPTS } = require('./cards');
const { hasFaction, findHostOfGear } = require('./primitives');
const _eval = () => require('./eval');

function matchCard(card, filter, b, ctx) {
  if (!filter) return true;

  if (filter.color   !== undefined && card.color?.toLowerCase() !== filter.color.toLowerCase()) return false;
  if (filter.type     !== undefined && card.type  !== filter.type) return false;
  if (filter.type_in  !== undefined && !filter.type_in.includes(card.type)) return false;
  if (filter.type_not !== undefined && card.type === filter.type_not) return false;
  if (filter.type_eq  !== undefined) {
    let t = filter.type_eq;
    if (b && ctx && typeof t === 'object' && t !== null) t = _eval().evalExpr(t, b, ctx);
    if (card.type !== t) return false;
  }
  if (filter.faction !== undefined && !hasFaction(card, filter.faction)) return false;
  if (filter.subtype_has !== undefined) {
    const subs = (card.subtype || '').split(', ').map(s => s.trim());
    if (!subs.includes(filter.subtype_has)) return false;
  }
  if (filter.cost_lte !== undefined) {
    let lte = filter.cost_lte;
    if (b && ctx && typeof lte === 'object' && lte !== null) lte = _eval().evalExpr(lte, b, ctx);
    if ((card.cost ?? Infinity) > lte) return false;
  }
  if (filter.cost_eq  !== undefined) {
    let eq = filter.cost_eq;
    if (b && ctx && typeof eq === 'object' && eq !== null)
      eq = _eval().evalExpr(eq, b, ctx);
    if (card.cost !== eq) return false;
  }
  if (filter.cost_in  !== undefined) {
    let arr = filter.cost_in;
    if (b && ctx && typeof arr === 'object' && !Array.isArray(arr)) arr = _eval().evalExpr(arr, b, ctx);
    if (Array.isArray(arr) && !arr.includes(card.cost)) return false;
  }
  if (filter.has_keyword !== undefined) {
    const want = String(filter.has_keyword).toUpperCase();
    const statics = SCRIPTS[card.number]?.statics || [];
    if (!statics.some(st => st.kind === 'SelfKeyword' &&
                            String(st.keyword).toUpperCase() === want)) return false;
  }
  if (filter.any_of !== undefined)
    return filter.any_of.some(f => matchCard(card, f, b, ctx));

  return true;
}

function _refPower(ref, card, b, ctx) {
  if (b && ref._pid && b[ref._pid]) {
    const z = b[ref._pid].zones;
    if (z.field.some(u => u.iid === ref.iid) || z.legends.some(l => l.iid === ref.iid)) {
      const { applyStaticPower } = require('./events');
      return applyStaticPower(b, ref._pid, ref, ctx, DB, SCRIPTS);
    }
  }
  return card.power;
}

function matchFilter(ref, filter, b, ctx) {
  if (!filter) return true;
  const card = DB[ref.card_id] || {};

  if (filter.exclude_self === true && ref.iid === ctx?.self_iid) return false;
  if (filter.exclude_binding !== undefined) {
    const other = ctx?.bindings?.[filter.exclude_binding];
    if (other && other.iid === ref.iid) return false;
  }
  if (filter.opposite_side_of !== undefined) {
    const other = ctx?.bindings?.[filter.opposite_side_of];
    if (!other || !other._pid || other._pid === ref._pid) return false;
  }
  if (filter.in_binding !== undefined) {
    const bound = ctx?.bindings?.[filter.in_binding];
    const list = Array.isArray(bound) ? bound : bound ? [bound] : [];
    if (!list.some(r => r.iid === ref.iid)) return false;
  }
  if (!matchCard(card, filter, b, ctx)) return false;

  if (filter.power_lte !== undefined || filter.power_gte !== undefined || filter.power_eq !== undefined) {
    const pow = _refPower(ref, card, b, ctx);
    if (filter.power_lte !== undefined) {
      let lte = filter.power_lte;
      if (b && ctx && typeof lte === 'object' && lte !== null) lte = _eval().evalExpr(lte, b, ctx);
      if ((pow ?? Infinity) > lte) return false;
    }
    if (filter.power_gte !== undefined && (pow ?? -Infinity) < filter.power_gte) return false;
    if (filter.power_eq  !== undefined) {
      let eq = filter.power_eq;
      if (b && ctx && typeof eq === 'object' && eq !== null) eq = _eval().evalExpr(eq, b, ctx);
      if (pow !== eq) return false;
    }
  }

  if (filter.power_lt_friendly_max === true) {
    if (!b) return false;
    const { applyStaticPower } = require('./events');
    const refPow = applyStaticPower(b, ref._pid, ref, ctx, DB, SCRIPTS);
    let max = -Infinity;
    for (const u of b[ctx.self_pid].zones.field) {
      const p = applyStaticPower(b, ctx.self_pid, u, ctx, DB, SCRIPTS);
      if (p > max) max = p;
    }
    if (refPow >= max) return false;
  }

  if (filter.power_is_lowest === true) {
    if (!b || !ref._pid) return false;
    const { applyStaticPower } = require('./events');
    const refPow = applyStaticPower(b, ref._pid, ref, ctx, DB, SCRIPTS);
    for (const u of b[ref._pid].zones.field) {
      const p = applyStaticPower(b, ref._pid, u, ctx, DB, SCRIPTS);
      if (p < refPow) return false;
    }
  }

  if (filter.state !== undefined && ref.state !== filter.state) return false;

  if (filter.has_equipped_gear !== undefined) {
    const has = (ref.equipped_gear || []).length > 0;
    if (has !== !!filter.has_equipped_gear) return false;
  }
  if (filter.gear_count !== undefined) {
    if ((ref.equipped_gear || []).length !== filter.gear_count) return false;
  }
  if (filter.value !== undefined) {
    let targetVal = filter.value;
    if (b && ctx && typeof targetVal === 'object' && targetVal !== null && !Array.isArray(targetVal))
      targetVal = _eval().evalExpr(targetVal, b, ctx);
    if (Array.isArray(targetVal)) {
      if (!targetVal.includes(ref.value)) return false;
    } else {
      if (ref.value !== targetVal) return false;
    }
  }
  if (filter.value_not_in !== undefined) {
    let arr = filter.value_not_in;
    if (b && ctx && typeof arr === 'object' && !Array.isArray(arr)) arr = _eval().evalExpr(arr, b, ctx);
    if (Array.isArray(arr) && arr.includes(ref.value)) return false;
  }
  if (filter.value_gte !== undefined && (ref.value ?? -Infinity) < filter.value_gte) return false;
  if (filter.value_lte !== undefined && (ref.value ??  Infinity) > filter.value_lte) return false;

  if (filter.value_parity !== undefined) {
    if (typeof ref.value !== 'number') return false;
    if ((ref.value % 2 === 0 ? 'even' : 'odd') !== filter.value_parity) return false;
  }

  if (filter.value_eq_sides === true) {
    if (ref.value === undefined || ref.sides === undefined) return false;
    if (ref.value !== ref.sides) return false;
  }

  if (filter.sides !== undefined) {
    let targetSides = filter.sides;
    if (b && ctx && typeof targetSides === 'object' && targetSides !== null && !Array.isArray(targetSides))
      targetSides = _eval().evalExpr(targetSides, b, ctx);
    if (Array.isArray(targetSides)) {
      if (!targetSides.includes(ref.sides)) return false;
    } else {
      if (ref.sides !== targetSides) return false;
    }
  }
  return true;
}

function matchAffects(affects, candidate, sourcePid, b, srcIid) {
  if (!affects) return true;
  if (affects.is === 'equipped_host') {
    if (!srcIid) return false;
    const host = findHostOfGear(b, sourcePid, srcIid);
    return !!host && host.iid === candidate.iid;
  }
  if (affects.exclude_self === true && candidate.iid === srcIid) return false;
  if (affects.side === 'friendly' && candidate._pid !== sourcePid) return false;
  if (affects.side === 'opponent' && candidate._pid === sourcePid) return false;
  if (affects.filter) {
    const card = DB[candidate.card_id] || {};
    if (!matchCard(card, affects.filter, b, null)) return false;
  }
  return true;
}

module.exports = { matchCard, matchFilter, matchAffects };
