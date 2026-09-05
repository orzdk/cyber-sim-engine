'use strict';

const P = require('./primitives');
const { DB, SCRIPTS } = require('./cards');
const { haltToWaiting } = require('./board');
const { evalExpr, evalCondition, matchTrigger } = require('./eval');
const { matchAffects, matchCard } = require('./filters');
const { resolveEffects } = require('./effects');
const { traceEventFired, traceListener } = require('./trace');

const SELF_KEYS = {
  OnPlay:       'onPlay',
  OnCall:       'onCall',
  OnFlip:       'onFlip',
  OnDefeated:   'onDefeated',
  OnSpent:      'onSpent',
};

function fireEvent(b, event, base_ctx, opts) {
  const baseCtx = { ...base_ctx, event };
  traceEventFired(b, event, baseCtx);

  const listeners = _listenerDescriptors(b);

  // ── Phase A: self-reaction ────────────────────────────────────────────────
  if (!opts?.skipSelf && baseCtx.source_card_id && baseCtx.source_pid) {
    const selfKey = SELF_KEYS[event];
    if (selfKey) {
      const script = SCRIPTS[baseCtx.source_card_id];
      const block  = script?.[selfKey];
      if (Array.isArray(block) && block.length > 0) {
        const ctx = _selfCtx(baseCtx);
        const res = resolveEffects(block, b, ctx);
        if (res.halted) {
          return _withResume(res, event, base_ctx, listeners, 0);
        }
      }
    }
  }

  // ── Phase B: listener scan ────────────────────────────────────────────────
  return _scanListeners(b, event, base_ctx, listeners, 0);
}

function _selfCtx(baseCtx) {
  return {
    ...baseCtx,
    self_pid:     baseCtx.source_pid,
    self_iid:     baseCtx.source_iid,
    self_card_id: baseCtx.source_card_id,
    bindings:     {},
  };
}

function _listenerDescriptors(b) {
  const out = [];
  for (const { pid, ref } of _enumerateInPlay(b)) {
    const script = SCRIPTS[ref.card_id];
    if (!script?.abilities) continue;
    for (let ai = 0; ai < script.abilities.length; ai++) {
      const a = script.abilities[ai];
      if (a.kind !== 'triggered' || !a.trigger) continue;
      out.push({ pid, iid: ref.iid, card_id: ref.card_id, ai });
    }
  }

  for (const badge of (b.badges || [])) out.push({ badge_id: badge.id });
  return out;
}

function _findInPlay(b, pid, iid) {
  for (const u of b[pid].zones.field) {
    if (u.iid === iid) return u;
    for (const g of (u.equipped_gear || [])) if (g.iid === iid) return g;
  }
  for (const l of b[pid].zones.legends) {
    if (l.face !== 'face_up') continue;
    if (l.iid === iid) return l;
    for (const g of (l.equipped_gear || [])) if (g.iid === iid) return g;
  }
  return null;
}

function _scanListeners(b, event, base_ctx, listeners, startIdx) {
  for (let i = startIdx; i < listeners.length; i++) {
    if (listeners[i].badge_id != null) {
      const res = _fireBadge(b, listeners[i].badge_id, event, base_ctx);
      if (res?.halted) return _withResume(res, event, base_ctx, listeners, i + 1);
      continue;
    }
    const { pid, iid, card_id, ai } = listeners[i];
    const ref = _findInPlay(b, pid, iid);
    if (!ref || ref.card_id !== card_id) continue;   // left play since the event fired
    const ability = SCRIPTS[card_id].abilities[ai];

    const ctx = {
      ...base_ctx,
      event,
      self_pid:     pid,
      self_iid:     iid,
      self_card_id: card_id,
      bindings:     {},
    };

    if (!matchTrigger(ability.trigger, event, b, ctx)) continue;
    const rl = ability.trigger.rate_limit;
    const scopeId = P.rateLimitScopeId(ability.trigger, ref);
    if (rl === 'first_per_turn' && P.hasTriggered(b, pid, scopeId, event)) {
      traceListener(b, event, pid, ref, 'skip:rate_limit'); continue;
    }

    if (ability.condition && !evalCondition(ability.condition, b, ctx)) {
      traceListener(b, event, pid, ref, 'skip:cond'); continue;
    }

    if (rl === 'first_per_turn') P.markTriggered(b, pid, scopeId, event);
    traceListener(b, event, pid, ref, 'fire');

    const res = resolveEffects(ability.effect || [], b, ctx);
    if (res.halted) {
      return _withResume(res, event, base_ctx, listeners, i + 1);
    }
  }
  return { halted: false };
}

function _fireBadge(b, badge_id, event, base_ctx) {
  const badge = (b.badges || []).find(x => x.id === badge_id);
  if (!badge || badge.trigger?.event !== event) return null;
  const ctx = {
    ...base_ctx, event,
    self_pid: badge.owner_pid, self_iid: null, self_card_id: badge.source_card_id,
    bindings: {},
  };
  if (!matchTrigger(badge.trigger, event, b, ctx)) return null;
  if (badge.condition && !evalCondition(badge.condition, b, ctx)) return null;

  b.badges = (b.badges || []).filter(x => x.id !== badge.id);
  traceListener(b, event, badge.owner_pid, { iid: null, card_id: badge.source_card_id }, 'fire:badge');
  const res = resolveEffects(badge.effect || [], b, ctx);
  return res.halted ? res : null;
}

function _withResume(haltedState, event, base_ctx, listeners, next_index) {
  return {
    ...haltedState,
    halted: true,
    resume_continuation: { event, base_ctx, listeners, next_index },
  };
}

function fireEventResume(haltedState, response, b) {
  const { resumeEffects } = require('./effects');
  const finish = resumeEffects(haltedState, response, b);
  if (finish.halted) {
    return {
      ...finish,
      halted: true,
      resume_continuation: haltedState.resume_continuation,
    };
  }

  const rc = haltedState.resume_continuation;
  if (!rc) return { halted: false };
  return _scanListeners(b, rc.event, rc.base_ctx, rc.listeners, rc.next_index);
}

function _enumerateInPlay(b) {
  const out = [];
  for (const pid of ['p1', 'p2']) {
    for (const u of b[pid].zones.field) {
      out.push({ pid, ref: u });
      for (const g of (u.equipped_gear || [])) out.push({ pid, ref: g });
    }
    for (const l of b[pid].zones.legends) {
      if (l.face !== 'face_up') continue;
      out.push({ pid, ref: l });
      for (const g of (l.equipped_gear || [])) out.push({ pid, ref: g });
    }
  }
  return out;
}

function _matchWhen(when, ctx) {
  if (!when) return true;
  if (when.during_fight !== undefined && !!ctx.during_fight !== !!when.during_fight) return false;
  if (when.role         !== undefined && ctx.role !== when.role) return false;
  if (when.vs_type      !== undefined && ctx.opp_type !== when.vs_type) return false;
  if (when.active_player !== undefined) {
    const expected = when.active_player === 'self' ? ctx.self_pid : P.opponent(ctx.self_pid);
    if (ctx.active_player !== expected) return false;
  }
  return true;
}

function applyStaticPower(b, pid, unit, ctx) {
  const base  = DB[unit.card_id]?.power || 0;
  let   power = base + (unit._temp_power || 0);
  let   mult  = 1;

  for (const g of (unit.equipped_gear || [])) {
    power += DB[g.card_id]?.power || 0;
  }

  const gate = {
    active_player: ctx?.active_player ?? b.active_player,
    during_fight:  ctx?.during_fight,
    role:          ctx?.role,
    opp_type:      ctx?.opp_type,
  };

  for (const e of (unit._temp_power_when || []))
    if (_matchWhen(e.when, { self_pid: pid, ...gate })) power += e.n;

  const unitBinding = { ...unit, _pid: pid };
  const script = SCRIPTS[unit.card_id];

  if (script?.statics) {
    const selfCtx = {
      self_pid: pid, self_iid: unit.iid, self_card_id: unit.card_id,
      bindings: {}, ...gate,
    };
    for (const s of script.statics) {
      if (s.kind === 'SelfPower'      && _matchWhen(s.when, selfCtx))
        power += evalExpr(s.expr, b, selfCtx);
      else if (s.kind === 'PowerMultiplier' && _matchWhen(s.when, selfCtx))
        mult *= s.factor;
    }
  }

  for (const { pid: srcPid, ref: srcRef } of _enumerateInPlay(b)) {
    const srcScript = SCRIPTS[srcRef.card_id];
    if (!srcScript?.statics) continue;
    const srcCtx = {
      self_pid: srcPid, self_iid: srcRef.iid, self_card_id: srcRef.card_id,
      bindings: {}, ...gate,
    };
    for (const s of srcScript.statics) {
      if (s.kind !== 'Aura') continue;
      if (!matchAffects(s.affects, unitBinding, srcPid, b, srcRef.iid)) continue;
      if (!_matchWhen(s.when, srcCtx)) continue;
      if (s.requires && !evalCondition(s.requires, b, srcCtx)) continue;
      power += evalExpr(s.expr, b, srcCtx);
    }
  }

  return Math.max(0, Math.floor(power * mult));
}

function effectiveKeywords(b, pid, unit) {
  const out = new Set((unit._temp_keywords || []).map(k => k.toUpperCase()));
  for (const e of (unit._until_keywords || [])) out.add(e.kw);

  const script = SCRIPTS[unit.card_id];
  if (script?.statics) {
    const selfCtx = {
      self_pid: pid, self_iid: unit.iid, self_card_id: unit.card_id,
      bindings: {},
    };
    for (const s of script.statics) {
      if (s.kind === 'SelfKeyword' && (!s.condition || evalCondition(s.condition, b, selfCtx)))
        out.add(String(s.keyword).toUpperCase());
    }
  }

  const unitBinding = { ...unit, _pid: pid };
  for (const { pid: srcPid, ref: srcRef } of _enumerateInPlay(b)) {
    const srcScript = SCRIPTS[srcRef.card_id];
    if (!srcScript?.statics) continue;
    const srcCtx = {
      self_pid: srcPid, self_iid: srcRef.iid, self_card_id: srcRef.card_id,
      bindings: {},
    };
    for (const s of srcScript.statics) {
      if (s.kind !== 'AuraKeyword') continue;
      if (!matchAffects(s.affects, unitBinding, srcPid, b, srcRef.iid)) continue;
      if (s.condition && !evalCondition(s.condition, b, srcCtx)) continue;
      out.add(String(s.keyword).toUpperCase());
    }
  }

  return [...out];
}

// True if `unit` auto-wins a fight against the card `oppCardId`, regardless of
// power (Johnny Silverhand vs CORPO). `vs` is a CardFilter on the opposing card.
function alwaysWinsFight(b, pid, unit, oppCardId) {
  const script = SCRIPTS[unit.card_id];
  if (!script?.statics || !oppCardId) return false;
  const oppCard = DB[oppCardId] || {};
  const selfCtx = {
    self_pid: pid, self_iid: unit.iid, self_card_id: unit.card_id,
    bindings: {},
  };
  for (const s of script.statics) {
    if (s.kind !== 'AlwaysWinsFight') continue;
    if (s.vs && !matchCard(oppCard, s.vs, b, selfCtx)) continue;
    if (s.condition && !evalCondition(s.condition, b, selfCtx)) continue;
    return true;
  }
  return false;
}

// Cost to play `legend` via GO SOLO — its printed cost plus any SoloCostTax
// statics in play. `side` on the static names whose Go Solo is taxed, seen from
// the taxing card's controller (default 'opponent' — Riot Shield taxes rivals).
function goSoloCost(b, pid, legend) {
  let cost = DB[legend.card_id]?.cost || 0;
  for (const { pid: srcPid, ref } of _enumerateInPlay(b)) {
    for (const s of (SCRIPTS[ref.card_id]?.statics || [])) {
      if (s.kind !== 'SoloCostTax') continue;
      const taxed = (s.side || 'opponent') === 'opponent' ? P.opponent(srcPid) : srcPid;
      if (taxed === pid) cost += s.amount || 0;
    }
  }
  if (legend._solo_discount) {
    const d = legend._solo_discount;
    cost = Math.max(d.min ?? 1, cost - (d.amount || 0));
  }
  return Math.max(0, cost);
}

// Calling a Legend costs 1 €$; a friendly LegendCallDiscount static reduces it
// (Panam Palmer — Strength Through Family makes the call free).
function legendCallCost(b, pid) {
  let cost = 1;
  for (const { pid: srcPid, ref } of _enumerateInPlay(b)) {
    if (srcPid !== pid) continue;
    for (const s of (SCRIPTS[ref.card_id]?.statics || [])) {
      if (s.kind !== 'LegendCallDiscount') continue;
      cost -= s.amount || 0;
    }
  }
  return Math.max(0, cost);
}

function fireOrHalt(b, event, ctx, defaultOwner, opts) {
  const r = fireEvent(b, event, ctx, opts);
  if (r?.halted) return haltToWaiting(b, 'resume_fire_event', r, defaultOwner);
  return null;
}

function fireEventChain(b, events, ctx, defaultOwner, opts) {
  for (const event of events) {
    const w = fireOrHalt(b, event, ctx, defaultOwner, opts);
    if (w) return w;
  }
  return null;
}

module.exports = {
  fireEvent,
  fireEventResume,
  fireOrHalt,
  fireEventChain,
  applyStaticPower,
  effectiveKeywords,
  alwaysWinsFight,
  goSoloCost,
  legendCallCost,
};
