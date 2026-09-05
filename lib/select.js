'use strict';

const P = require('./primitives');
const { DB } = require('./cards');
const { evalExpr } = require('./eval');
const { matchFilter } = require('./filters');

function _bindingOf(ref, pid) { return { ...ref, _pid: ref._pid ?? pid }; }

function _sideOf(target, ctx) {
  return target.side === 'opponent' ? P.opponent(ctx.self_pid) : ctx.self_pid;
}

function _defaultZone(type) {
  switch (type) {
    case 'Gig':     return 'gigs';
    case 'Unit':    return 'field';
    case 'Legend':  return 'legends';
    case 'Gear':    return 'equipped';
    default:        return null;
  }
}

function _candidates(b, pid, target, ctx) {
  const zone = target.zone || _defaultZone(target.type);
  const sides = target.side === 'both' ? ['p1', 'p2'] : [pid];
  let pool = [];
  for (const sidePid of sides) {
    let sub;
    if (zone === 'equipped') {
      sub = [];
      let hosts = [...b[sidePid].zones.field, ...b[sidePid].zones.legends];
      if (target.equipped_to?.from_self) hosts = hosts.filter(h => h.iid === ctx.self_iid);
      for (const host of hosts)
        for (const g of (host.equipped_gear || [])) sub.push({ ...g, _host_iid: host.iid, _pid: sidePid });
    } else if (zone === 'in_play') {
      sub = [
        ...b[sidePid].zones.field.map(r => ({ ...r, _pid: sidePid })),
        ...b[sidePid].zones.legends.filter(l => l.face === 'face_up').map(r => ({ ...r, _pid: sidePid })),
      ];
    } else if (zone === 'hand_or_trash') {
      sub = [
        ...b[sidePid].zones.hand.map(r => ({ ...r, _pid: sidePid })),
        ...(b[sidePid].zones.trash || []).map(r => ({ ...r, _pid: sidePid })),
      ];
    } else {
      sub = (b[sidePid].zones[zone] || []).map(r => ({ ...r, _pid: sidePid }));
    }
    pool.push(...sub);
  }

  const MIXED_ZONES = new Set(['hand', 'trash', 'deck', 'hand_or_trash']);
  if (target.type && target.type !== 'CardRef' && MIXED_ZONES.has(zone)) {
    pool = pool.filter(ref => {
      const c = DB?.[ref.card_id];
      return c?.type === target.type;
    });
  }
  if (target.type === 'Legend') {
    pool = pool.filter(l => (target.face ? l.face === target.face : true));
  }
  if (target.filter) pool = pool.filter(c => matchFilter(c, target.filter, b, ctx));
  return { pool, zone };
}

function _sortAuto(pool, target, ctx) {
  const hint = target.auto || 'first';
  const byCost = (a, z) => (DB[a.card_id]?.cost ?? 0) - (DB[z.card_id]?.cost ?? 0);
  const byPow  = (a, z) => (DB[a.card_id]?.power ?? 0) - (DB[z.card_id]?.power ?? 0);
  switch (hint) {
    case 'cheapest':      return [...pool].sort(byCost);
    case 'highest_value': return [...pool].sort((a, z) => z.value - a.value);
    case 'lowest_value':  return [...pool].sort((a, z) => a.value - z.value);
    case 'highest_power': return [...pool].sort((a, z) => byPow(z, a));
    case 'lowest_power':  return [...pool].sort(byPow);
    case 'first':
    default:              return pool;
  }
}

function _choiceKind(type, zone) {
  if (type === 'Gig') return 'choose_gig';
  if (zone === 'in_play')       return 'choose_in_play';
  if (zone === 'hand_or_trash') return 'choose_card_in_hand_or_trash';
  if (zone === 'hand')          return 'choose_card_in_hand';
  if (zone === 'trash')  return 'choose_card_in_trash';
  if (zone === 'deck')   return 'choose_card_in_deck';
  if (type === 'Gear')   return 'choose_gear';
  if (type === 'Legend') return 'choose_legend';
  return 'choose_unit';
}

function _describeAutoPick(target, picked, ctx, zone) {
  const sourceName = DB?.[ctx.self_card_id]?.name || ctx.self_card_id || '?';
  const targetName = DB?.[picked.card_id]?.name   || picked.card_id   || '?';
  const sidePrefix = target.side === 'opponent' ? 'rival ' : '';
  const kind       = _choiceKind(target.type, zone);
  let what;
  switch (kind) {
    case 'choose_gig':           what = `d${picked.sides} gig`;                  break;
    case 'choose_unit':          what = `${targetName} unit`;                    break;
    case 'choose_legend':        what = 'face-down legend';                      break;
    case 'choose_gear':          what = `${targetName} gear`;                    break;
    case 'choose_card_in_hand':          what = `${targetName} in hand`;          break;
    case 'choose_card_in_trash':         what = `${targetName} in trash`;         break;
    case 'choose_card_in_deck':          what = `${targetName} in deck`;          break;
    case 'choose_card_in_hand_or_trash': what = `${targetName} in hand/trash`;   break;
    default:                     what = targetName;                              break;
  }
  return `${sourceName}: ${sidePrefix}${what} autopicked`;
}

function _describeFilter(filter) {
  if (!filter) return 'card';
  const parts = [];
  const type = filter.type || (filter.type_in ? filter.type_in.join('/') : null);
  parts.push(type || 'card');
  if (filter.cost_lte !== undefined)  parts.push(`costing ${filter.cost_lte} or less`);
  if (filter.cost_eq  !== undefined && typeof filter.cost_eq !== 'object') parts.push(`costing ${filter.cost_eq}`);
  if (filter.power_gte !== undefined) parts.push(`power ${filter.power_gte}+`);
  if (filter.power_lte !== undefined) parts.push(`power ${filter.power_lte} or less`);
  if (filter.faction)     parts.push(`(${filter.faction})`);
  if (filter.subtype_has) parts.push(`(${filter.subtype_has})`);
  if (filter.color)       parts.push(`(${filter.color})`);
  return parts.join(' ');
}

function selectTarget(target, b, ctx, bind) {
  const pid = _sideOf(target, ctx);
  const { pool, zone } = _candidates(b, pid, target, ctx);

  if (pool.length === 0) return target.optional ? { kind: 'skip' } : { kind: 'empty' };

  const quantifier = target.quantifier || 'one';

  if (quantifier === 'all') {
    return { kind: 'bind', value: pool.map(r => _bindingOf(r, pid)) };
  }

  if (quantifier === 'upto_n') {
    const n = Math.min(pool.length, evalExpr(target.n, b, ctx));
    if (target.chooser === 'controller' && n > 0 && pool.length > n) {

      const kindMulti = target.type === 'Unit' && zone === 'field' ? 'choose_units' : null;
      if (kindMulti) {
        return {
          kind: 'halt',
          choice_needed: {
            kind:           kindMulti,
            bind_to:        bind,
            bind_pid:       pid,
            chooser_pid:    ctx.self_pid,
            prompt:         target.prompt || `Choose up to ${n} ${target.type.toLowerCase()}s`,
            available_iids: pool.map(r => r.iid),
            take_up_to:     n,
            optional:       !!target.optional,
            source_card_id: ctx?.self_card_id,
            source_pid:     ctx?.self_pid,
          },
        };
      }
    }
    const sorted = _sortAuto(pool, target, ctx);
    return { kind: 'bind', value: sorted.slice(0, n).map(r => _bindingOf(r, pid)) };
  }

  const chooser = target.chooser || 'auto';
  if (chooser === 'auto' || pool.length === 1) {
    const sorted = _sortAuto(pool, target, ctx);
    const picked = sorted[0];

    if (chooser === 'controller' && pool.length === 1) {
      b._auto_picks = b._auto_picks || [];
      b._auto_picks.push({ pid: ctx.self_pid, desc: _describeAutoPick(target, picked, ctx, zone) });
    }

    return { kind: 'bind', value: _bindingOf(picked, pid) };
  }

  const chooserPid = chooser === 'opponent'
    ? (ctx.self_pid === 'p1' ? 'p2' : 'p1')
    : ctx.self_pid;

  const kind = _choiceKind(target.type, zone);
  return {
    kind: 'halt',
    choice_needed: {
      kind,
      bind_to:     bind,
      bind_pid:    pid,
      chooser_pid: chooserPid,
      prompt:      target.prompt || `Choose a ${target.type.toLowerCase()}`,
      available_iids: pool.map(r => r.iid),
      optional:    !!target.optional,
      source_card_id: ctx?.self_card_id,
      source_pid:     ctx?.self_pid,
    },
  };
}

function resolveTarget(target, b, ctx) {
  if (!target) return { ok: true, value: null };

  let bind = target.bind;
  if (!bind) {
    if (!ctx._auto_binds) ctx._auto_binds = {};
    const _k = JSON.stringify(target);
    bind = ctx._auto_binds[_k];
    if (!bind) {
      ctx._auto_bind_seq = (ctx._auto_bind_seq || 0) + 1;
      bind = '__auto_' + ctx._auto_bind_seq;
      ctx._auto_binds[_k] = bind;
    }
  }

  if (target.from_self) {
    const u = P.findOnBoard(b, ctx.self_pid, ctx.self_iid)
           || P.findEquippedGear(b, ctx.self_pid, ctx.self_iid);
    if (!u) return { ok: true, value: null };
    const v = { ...u, _pid: ctx.self_pid };
    ctx.bindings[bind] = v;
    return { ok: true, value: v };
  }

  if (target.from_binding) {
    const v = ctx.bindings[target.from_binding];
    if (!v) return { ok: true, value: null };
    ctx.bindings[bind] = v;
    return { ok: true, value: v };
  }

  if (target.from_host) {
    const host = P.findHostOfGear(b, ctx.self_pid, ctx.self_iid);
    if (!host) return { ok: true, value: null };
    const v = { ...host, _pid: ctx.self_pid };
    ctx.bindings[bind] = v;
    return { ok: true, value: v };
  }

  if (target.from_trigger_source) {
    const u = P.findOnBoard(b, ctx.source_pid, ctx.source_iid);
    if (!u) return { ok: true, value: null };
    const v = { ...u, _pid: ctx.source_pid };
    ctx.bindings[bind] = v;
    return { ok: true, value: v };
  }

  if (target.from_event) {
    const arr = ctx.event_data?.[target.from_event];
    if (!Array.isArray(arr) || arr.length === 0) return { ok: true, value: null };
    const bindings = arr.map(e => ({ ...e, _pid: e._pid ?? e.pid }));
    ctx.bindings[bind] = bindings;
    return { ok: true, value: bindings };
  }

  if (ctx.bindings[bind] !== undefined) {
    return { ok: true, value: ctx.bindings[bind] };
  }

  const r = selectTarget(target, b, ctx, bind);
  if (r.kind === 'halt')  return { ok: false, halt: r.choice_needed };
  if (r.kind === 'skip')  return { ok: true, value: null, skipped: true };
  if (r.kind === 'empty') return { ok: true, value: null, empty: true };
  ctx.bindings[bind] = r.value;
  return { ok: true, value: r.value };
}

module.exports = { resolveTarget, describeFilter: _describeFilter };
