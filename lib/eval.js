'use strict';

const { DB, SCRIPTS } = require('./cards');
const { opponent, streetCred, findOnBoard, findHostOfGear, readyPool } = require('./primitives');
const { matchCard, matchFilter } = require('./filters');
const { trace } = require('./trace');

function evalExpr(expr, b, ctx) {
  if (expr === undefined || expr === null) return 0;
  if (typeof expr === 'number') return expr;
  if (!expr.op) return 0;

  const side = s => (s === 'opponent' ? opponent(ctx.self_pid) : ctx.self_pid);

  switch (expr.op) {
    case 'lit': return expr.value ?? 0;

    case 'add': return (expr.args || []).reduce((a, x) => a + evalExpr(x, b, ctx), 0);
    case 'sub': {
      const a = expr.args || [];
      if (a.length === 0) return 0;
      return a.slice(1).reduce((x, y) => x - evalExpr(y, b, ctx), evalExpr(a[0], b, ctx));
    }
    case 'mul': {
      let r = 1;
      for (const x of (expr.args || [])) r *= evalExpr(x, b, ctx);
      return r;
    }
    case 'mod': {
      const a = expr.args || [];
      if (a.length < 2) return 0;
      const d = evalExpr(a[1], b, ctx);
      return d === 0 ? 0 : evalExpr(a[0], b, ctx) % d;
    }

    case 'ref': {
      const parts = expr.name.split('.');
      let v = ctx.bindings?.[parts[0]];
      for (let i = 1; i < parts.length && v != null; i++) v = v[parts[i]];
      return typeof v === 'number' ? v : 0;
    }

    case 'binding': return ctx.bindings?.[expr.name] ?? null;

    case 'gig_value': {
      const g = ctx.bindings?.[expr.ref];
      return g?.value ?? 0;
    }
    case 'gig_sides': {
      const g = ctx.bindings?.[expr.ref];
      return g?.sides ?? 0;
    }

    case 'street_cred': return streetCred(b[side(expr.side)]);
    case 'gig_count':   return b[side(expr.side)].zones.gigs.length;
    case 'gig_values':  return b[side(expr.side)].zones.gigs.map(g => g.value);

    case 'value_pair_count': {
      const gigs = b[side(expr.side)].zones.gigs;
      const counts = {};
      for (const g of gigs) counts[g.value] = (counts[g.value] || 0) + 1;
      let pairs = 0;
      for (const v in counts) pairs += Math.floor(counts[v] / 2);
      return pairs;
    }

    case 'count': {
      const pid  = side(expr.side);
      const zone = expr.zone || 'field';
      const cards = b[pid].zones[zone] || [];
      if (!expr.filter) return cards.length;
      let n = 0;
      for (const c of cards) if (matchFilter(c, expr.filter, b, ctx)) n++;
      return n;
    }

    case 'eddie_pool': return readyPool(b[side(expr.side)]);

    case 'gear_count': {
      const hostIid = expr.from_source ? ctx.source_iid
                    : expr.ref         ? ctx.bindings?.[expr.ref]?.iid
                    : ctx.self_iid;
      if (!hostIid) return 0;
      for (const pid of ['p1', 'p2']) {
        const u = b[pid].zones.field.find(x => x.iid === hostIid) ||
                  b[pid].zones.legends.find(x => x.iid === hostIid);
        if (u) return (u.equipped_gear || []).length;
      }
      return 0;
    }

    case 'legend_face_count': {
      const pid = side(expr.side);
      const face = expr.face || 'face_up';
      return b[pid].zones.legends.filter(l => l.face === face).length;
    }

    case 'source_power': {
      const src = ctx.source_pid && ctx.source_iid
        ? findOnBoard(b, ctx.source_pid, ctx.source_iid) : null;
      if (!src) return 0;
      const { applyStaticPower } = require('./events');
      return applyStaticPower(b, ctx.source_pid, src, ctx);
    }

    case 'self_power': {
      const u = _findSelf(b, ctx);
      if (!u) return 0;
      const { applyStaticPower } = require('./events');
      return applyStaticPower(b, ctx.self_pid, u, ctx);
    }

    case 'card_cost': {
      const bound = ctx.bindings?.[expr.ref];
      const ref = Array.isArray(bound) ? bound[0] : bound;
      return DB[ref?.card_id]?.cost ?? 0;
    }

    case 'self_pid':    return ctx.self_pid ?? null;
    case 'opp_pid':     return ctx.self_pid ? (ctx.self_pid === 'p1' ? 'p2' : 'p1') : null;

    case 'event_field': {
      const data = ctx.event_data;
      if (data == null) return 0;
      const m = String(expr.field || '').match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+|\*)\])?(?:\.([A-Za-z_][A-Za-z0-9_]*))?$/);
      if (!m) return 0;
      const [, key, idx, sub] = m;
      let v = data[key];
      if (idx === undefined) return v ?? 0;
      if (idx === '*') {
        if (!Array.isArray(v)) return [];
        return sub ? v.map(x => (x == null ? undefined : x[sub])) : v;
      }
      v = Array.isArray(v) ? v[Number(idx)] : undefined;
      if (sub && v != null) v = v[sub];
      return v ?? 0;
    }

    default:
      // Unknown ops never break a running game — evaluate to 0, leave a trace.
      trace(b, `T${b.turn_number}/warn unknown expr op "${expr.op}" -> 0`);
      return 0;
  }
}

function evalCondition(cond, b, ctx) {
  if (!cond) return true;
  const side = s => (s === 'opponent' ? opponent(ctx.self_pid) : ctx.self_pid);

  switch (cond.cond) {
    case 'True':  return true;
    case 'False': return false;

    case 'And': return (cond.args || []).every(c => evalCondition(c, b, ctx));
    case 'Or':  return (cond.args || []).some (c => evalCondition(c, b, ctx));
    case 'Not': return !evalCondition(cond.arg, b, ctx);

    case 'Compare': return _compare(evalExpr(cond.lhs, b, ctx), cond.op, evalExpr(cond.rhs, b, ctx));

    case 'StreetCred': {
      const p = b[side(cond.side)];
      if (p.zones.gigs.length === 0)
        return cond.op === '<' || cond.op === '<=' || cond.op === '!=';
      return _compare(streetCred(p), cond.op, cond.value);
    }

    case 'GigAtMaxValue': {
      const g = ctx.bindings?.[cond.ref];
      return !!(g && g.value === g.sides);
    }

    case 'IsMinOrMax': {
      const value = evalExpr(cond.value, b, ctx);
      const sides = evalExpr(cond.sides, b, ctx);
      return value === 1 || (sides > 0 && value === sides);
    }

    case 'GigValueExists': {
      const target = evalExpr(cond.value, b, ctx);
      const gigs   = b[side(cond.side)].zones.gigs;
      return gigs.some(g => g.value === target);
    }

    case 'HasSidedPair': {
      const sides = b[side(cond.side)].zones.gigs.map(g => g.sides);
      return sides.some((s, i) => sides.indexOf(s) !== i);
    }

    case 'HasValuePair': {
      const seen = new Set();
      for (const g of b[side(cond.side)].zones.gigs) {
        if (seen.has(g.value)) return true;
        seen.add(g.value);
      }
      return false;
    }

    case 'DistinctGigValueCount': {
      const seen = new Set();
      for (const g of b[side(cond.side)].zones.gigs) seen.add(g.value);
      return _compare(seen.size, cond.op, cond.value);
    }

    case 'HasInZone': {
      const zone  = cond.zone;
      const cards = b[side(cond.side)].zones[zone] || [];
      return cards.some(c => matchFilter(c, cond.filter, b, ctx));
    }
    case 'HasInZoneN': {
      const zone  = cond.zone;
      const cards = b[side(cond.side)].zones[zone] || [];
      let n = 0;
      for (const c of cards) if (matchFilter(c, cond.filter, b, ctx)) n++;
      return n >= (cond.n || 1);
    }

    case 'CanCallLegend': {
      const p = b[ctx.self_pid];
      return !!p && !p.called_legend_this_turn &&
             p.zones.legends.some(l => l.face === 'face_down');
    }

    case 'SelfIsReady': {
      const u = _findSelf(b, ctx);
      return u?.state === 'ready';
    }
    case 'SelfIsSpent': {
      const u = _findSelf(b, ctx);
      return u?.state === 'spent';
    }

    case 'SelfDidCombat': {
      const u = _findSelf(b, ctx);
      return !!(u && u._combat_this_turn);
    }

    case 'SelfStoleGig': {
      const u = _findSelf(b, ctx);
      return !!(u && u._stole_gig_this_turn);
    }

    case 'PlayedProgramThisTurn':
      return !!b[side(cond.side)]._played_program_this_turn;

    case 'SelfEquipsSource': {
      if (!ctx.source_iid || !ctx.self_iid) return false;
      const src = findOnBoard(b, ctx.source_pid, ctx.source_iid);
      return !!(src?.equipped_gear?.some(g => g.iid === ctx.self_iid));
    }

    case 'HostEquipsSelf': {
      const u = _findSelf(b, ctx);
      return (u?.equipped_gear || []).length > 0;
    }

    case 'HostNamed': {
      const host = findHostOfGear(b, ctx.self_pid, ctx.self_iid);
      if (!host) return false;
      return _leadName((DB[host.card_id] || {}).name) === _leadName(cond.name);
    }

    case 'BoundMatches': {
      const ref = ctx.bindings?.[cond.ref];
      if (!ref) return false;
      if (Array.isArray(ref))
        return ref.some(r => matchCard(DB[r.card_id] || {}, cond.filter, b, ctx));
      return matchCard(DB[ref.card_id] || {}, cond.filter, b, ctx);
    }

    case 'SourceIsSelf':       return ctx.source_iid && ctx.source_iid === ctx.self_iid;
    case 'SourceIsController': return ctx.source_pid === ctx.self_pid;
    case 'SourceIsOpponent':   return ctx.source_pid && ctx.source_pid !== ctx.self_pid;
    case 'BindingSet':         return !!ctx.bindings && ctx.bindings[cond.name] != null;

    default:
      trace(b, `T${b.turn_number}/warn unknown condition "${cond.cond}" -> false`);
      return false;
  }
}

function _compare(a, op, b) {
  switch (op) {
    case '>':  return a >  b;
    case '>=': return a >= b;
    case '<':  return a <  b;
    case '<=': return a <= b;
    case '==': return a === b;
    case '!=': return a !== b;
    default:   return false;
  }
}

function _findSelf(b, ctx) {
  if (!ctx.self_iid || !ctx.self_pid) return null;
  return findOnBoard(b, ctx.self_pid, ctx.self_iid);
}

// The lead name is the part before the subtitle separator. The publisher has
// used both " — " and ": " (the set was renamed wholesale in Aug 2026), so
// accept either, plus a comma.
function _leadName(s) {
  return String(s || '')
    .split(/ [—–-] |: |, /)[0]
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchTrigger(trigger, event, b, ctx) {
  if (!trigger || trigger.event !== event) return false;

  const by = trigger.by || 'any';
  switch (by) {
    case 'self':
      if (ctx.source_iid !== ctx.self_iid) return false;
      break;
    case 'controller':
      if (ctx.source_pid !== ctx.self_pid) return false;
      break;
    case 'opponent':
      if (!ctx.source_pid || ctx.source_pid === ctx.self_pid) return false;
      break;
    case 'host': {
      if (!ctx.source_iid || !ctx.self_iid) return false;
      const src = findOnBoard(b, ctx.source_pid, ctx.source_iid);
      if (!src?.equipped_gear?.some(g => g.iid === ctx.self_iid)) return false;
      break;
    }
    case 'any': /* no-op */ break;
    default: return false;
  }

  if (trigger.card) {
    const srcCard = ctx.source_card_id ? (DB[ctx.source_card_id] || {}) : {};
    if (!matchCard(srcCard, trigger.card, b, ctx)) return false;
  }

  return true;
}

module.exports = { evalExpr, evalCondition, matchTrigger };
