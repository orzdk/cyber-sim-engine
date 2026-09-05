'use strict';

const P = require('./primitives');
const { DB, SCRIPTS } = require('./cards');
const { evalExpr, evalCondition } = require('./eval');
const { matchFilter } = require('./filters');
const { trace, traceEffect } = require('./trace');
const { shuffle, randFloat } = require('./rng');
const { resolveTarget: _resolveTarget, describeFilter: _describeFilter } = require('./select');
const CHOICE_TYPES = require('../data/choice-types.json');


function revealedRefs(bound) {
  return (Array.isArray(bound) ? bound : bound ? [bound] : [])
    .map(r => ({ iid: r.iid, card_id: r.card_id }));
}

function fightOutcome(atk) {
  if (!!atk._att_autowin !== !!atk._def_autowin)
    return { attLoses: !!atk._def_autowin, defLoses: !!atk._att_autowin };
  return { attLoses: atk._dp >= atk._ap, defLoses: atk._ap >= atk._dp };
}

function resolveEffect(effect, b, ctx) {
  if (!effect || !effect.action) return { continue: true };

  switch (effect.action) {

    case 'Optional': {
      if (Array.isArray(effect.body) && effect.body.length > 0) {

        const sourceName = DB[ctx.self_card_id]?.name || null;
        const choice_needed = {
          kind: 'confirm_optional',
          bind_pid: effect.chooser === 'opponent' ? P.opponent(ctx.self_pid) : ctx.self_pid,
          prompt: effect.prompt || (sourceName ? `Use ${sourceName}?` : 'Optional effect'),
          pending_body: effect.body,
          otherwise_body: effect.otherwise || null,
          optional: true,
          source_card_id: ctx?.self_card_id,
          source_pid:     ctx?.self_pid,
        };

        if (effect.reveal_from) {
          const refs = revealedRefs(ctx.bindings[effect.reveal_from]);
          if (refs.length) choice_needed.context = { revealed_refs: refs };
        }

        if (effect.accept_label)  choice_needed.accept_label  = effect.accept_label;
        if (effect.decline_label) choice_needed.decline_label = effect.decline_label;
        return { continue: false, no_repush: true, choice_needed };
      }
      return { continue: true };
    }

    case 'ChooseAmount': {
      const min = evalExpr(effect.min, b, ctx);
      const max = evalExpr(effect.max, b, ctx);
      return {
        continue: false,
        no_repush: true,
        choice_needed: {
          kind: 'choose_amount',
          bind_pid: effect.chooser === 'opponent' ? P.opponent(ctx.self_pid) : ctx.self_pid,
          bind_to: effect.bind_to || effect.bind,
          prompt: effect.prompt || 'Choose amount',
          min, max,
          exclude_zero: !!effect.exclude_zero,
        },
      };
    }

    case 'ChooseCardType': {
      return {
        continue: false,
        no_repush: true,
        choice_needed: {
          kind: 'choose_card_type',
          bind_pid: effect.chooser === 'opponent' ? P.opponent(ctx.self_pid) : ctx.self_pid,
          bind_to: effect.bind_to || effect.bind,
          prompt: effect.prompt || 'Choose a card type',
          options: effect.options || ['Unit', 'Gear', 'Program'],
        },
      };
    }

    case 'If': {
      const ok = evalCondition(effect.cond, b, ctx);
      const branch = ok ? effect.then : effect.else;
      if (Array.isArray(branch) && branch.length > 0)
        return { continue: true, queue: branch };
      return { continue: true };
    }

    case 'AddBadge': {

      b.badges = b.badges || [];
      b._badge_seq = (b._badge_seq || 0) + 1;
      b.badges.push({
        id:             b._badge_seq,
        owner_pid:      ctx.self_pid,
        trigger:        effect.trigger,
        condition:      effect.condition || null,
        effect:         effect.effect || [],
        source_card_id: ctx.self_card_id,
      });
      return { continue: true };
    }

    // ─── Card flow ──────────────────────────────────────────────────────────

    case 'Draw': {
      const n = effect.n !== undefined ? evalExpr(effect.n, b, ctx) : 1;
      const pid = effect.side === 'opponent' ? P.opponent(ctx.self_pid) : ctx.self_pid;
      P.draw(b, pid, n);
      return { continue: true };
    }

    case 'BindValue': {
      ctx.bindings[effect.bind_to || effect.bind] = evalExpr(effect.value, b, ctx);
      return { continue: true };
    }

    case 'Discard': {
      const n = effect.n !== undefined ? evalExpr(effect.n, b, ctx) : 1;
      if (effect.target) {
        const r = _resolveTarget(effect.target, b, ctx);
        if (!r.ok) return { continue: false, choice_needed: r.halt };
        const bound = r.value;
        if (Array.isArray(bound)) for (const c of bound) P.discardHandIid(b, c._pid, c.iid);
        else if (bound) P.discardHandIid(b, bound._pid, bound.iid);
      } else {
        P.discardHandTop(b, ctx.self_pid, n);
      }
      return { continue: true };
    }

    case 'Mill': {
      const n   = effect.n !== undefined ? evalExpr(effect.n, b, ctx) : 1;
      const pid = effect.side === 'opponent' ? P.opponent(ctx.self_pid) : ctx.self_pid;
      const milled = P.mill(b, pid, n);
      if (effect.bind) ctx.bindings[effect.bind] = milled.map(r => ({ ...r, _pid: pid }));
      return { continue: true };
    }

    case 'SellTopCard': {
      const ref = b[ctx.self_pid].zones.deck.shift();
      if (ref) b[ctx.self_pid].zones.eddies.push({ iid: ref.iid, card_id: ref.card_id, state: 'ready' });
      return { continue: true };
    }

    case 'RecoverFromTrash': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (bound) P.recoverIid(b, bound._pid, bound.iid);
      return { continue: true };
    }

    case 'SelectTarget': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      return { continue: true };
    }

    case 'RevealTop': {
      const n    = evalExpr(effect.n, b, ctx);
      const pid  = ctx.self_pid;
      const deck = b[pid].zones.deck;
      const topN = deck.splice(0, Math.min(n, deck.length));
      if (effect.bind) ctx.bindings[effect.bind] = topN;
      return { continue: true };
    }

    case 'AckReveal': {
      const refs = revealedRefs(ctx.bindings[effect.from]);
      if (refs.length === 0) return { continue: true };
      return {
        continue: false,
        no_repush: true,
        choice_needed: {
          kind: 'acknowledge_reveal',
          bind_pid: ctx.self_pid,
          revealed_refs: refs,
          context: { revealed_refs: refs },
          prompt: effect.prompt || 'Revealed from the top of your deck',
        },
      };
    }

    case 'TakeFromBound': {
      const fromName = effect.from;
      const bound    = ctx.bindings[fromName];
      if (!Array.isArray(bound) || bound.length === 0) return { continue: true };
      const pid      = ctx.self_pid;
      const kept     = effect.take_none ? []
        : effect.filter ? bound.filter(r => matchFilter(r, effect.filter, b, ctx))
        : bound;
      const keptSet  = new Set(kept.map(r => r.iid));
      const rest     = bound.filter(r => !keptSet.has(r.iid));
      b._reveals = b._reveals || [];
      b._reveals.push({
        pid,
        revealed: bound.map(r => r.card_id),
        picked:   kept.map(r => r.card_id),
      });
      for (const ref of kept) b[pid].zones.hand.push(ref);
      if (effect.trash_remainder) {
        b[pid].zones.trash.push(...rest);
      } else if (effect.to_top) {
        b[pid].zones.deck.unshift(...rest);      // "keep it on top of your deck"
      } else {
        b[pid].zones.deck.push(...shuffle(b, rest));
      }

      delete ctx.bindings[fromName];
      return { continue: true };
    }

    case 'SearchTopN': {
      const n        = evalExpr(effect.n, b, ctx);
      const takeUpTo = evalExpr(effect.take_up_to, b, ctx);
      const pid      = ctx.self_pid;
      const deck     = b[pid].zones.deck;
      const topN     = deck.splice(0, Math.min(n, deck.length));
      const eligible = effect.filter
        ? topN.filter(r => matchFilter(r, effect.filter, b, ctx))
        : topN;

      if (effect.auto_take_all && eligible.length > 0) {
        const eligibleSet = new Set(eligible.map(r => r.iid));
        const kept = topN.filter(r => eligibleSet.has(r.iid));
        const rest = topN.filter(r => !eligibleSet.has(r.iid));
        b._reveals = b._reveals || [];
        b._reveals.push({ pid, revealed: topN.map(r => r.card_id), picked: kept.map(r => r.card_id) });
        for (const ref of kept) b[pid].zones.hand.push(ref);
        if (effect.trash_remainder) {
          b[pid].zones.trash.push(...rest);
        } else {
          deck.push(...shuffle(b, rest));
        }
        return { continue: true };
      }
      if (eligible.length === 0 || takeUpTo === 0) {
        if (topN.length) {
          b._reveals = b._reveals || [];
          b._reveals.push({
            pid,
            revealed: topN.map(r => r.card_id),
            picked:   [],
          });
        }

        if (eligible.length === 0 && effect.filter) {
          const sourceName = DB?.[ctx.self_card_id]?.name || ctx.self_card_id || '?';
          b._auto_picks = b._auto_picks || [];
          b._auto_picks.push({ pid, desc: `${sourceName}: no ${_describeFilter(effect.filter)} in top ${n}` });
        }
        if (effect.trash_remainder) {
          b[pid].zones.trash.push(...topN);
        } else {
          deck.push(...shuffle(b, topN));
        }
        return { continue: true };
      }
      return {
        continue: false,
        no_repush: true,
        choice_needed: {
          kind:            'choose_from_top_n',
          bind_pid:        pid,
          prompt:          effect.prompt || `Choose up to ${takeUpTo} card${takeUpTo !== 1 ? 's' : ''}`,
          available_refs:  topN,
          eligible_iids:   eligible.map(r => r.iid),
          take_up_to:      takeUpTo,
          trash_remainder: !!effect.trash_remainder,
        },
      };
    }

    case 'ScryTrash': {
      const n         = evalExpr(effect.n, b, ctx);
      const trashUpTo = evalExpr(effect.trash_up_to, b, ctx);
      const pid       = ctx.self_pid;
      const deck      = b[pid].zones.deck;
      const topN      = deck.splice(0, Math.min(n, deck.length));
      const eligible  = effect.filter ? topN.filter(r => matchFilter(r, effect.filter, b, ctx)) : topN;

      if (eligible.length === 0 || trashUpTo === 0) {
        deck.unshift(...topN);                       // nothing trashed → returned to top, in order
        if (topN.length) {
          b._reveals = b._reveals || [];
          b._reveals.push({ pid, revealed: topN.map(r => r.card_id), picked: [] });
        }
        return { continue: true };
      }

      const minTake = Math.min(
        effect.min_take !== undefined ? evalExpr(effect.min_take, b, ctx) : 0,
        trashUpTo, eligible.length);

      return {
        continue: false,
        no_repush: true,
        choice_needed: {
          kind:           'choose_from_top_n',
          bind_pid:       pid,
          prompt:         effect.prompt || `Choose up to ${trashUpTo} card${trashUpTo !== 1 ? 's' : ''} to trash`,
          available_refs: topN,
          eligible_iids:  eligible.map(r => r.iid),
          take_up_to:     trashUpTo,
          take_min:       minTake,
          scry_trash:     true,
        },
      };
    }

    case 'RivalDiscards': {
      const TEMP_BIND = '_rd_pick';
      const pid = P.opponent(ctx.self_pid);
      const n   = effect.n !== undefined ? evalExpr(effect.n, b, ctx) : 1;

      const picked = ctx.bindings[TEMP_BIND];
      if (picked) {
        delete ctx.bindings[TEMP_BIND];
        const card = b[pid].zones.hand.find(x => x.iid === picked.iid);
        if (card) {
          P.discardHandIid(b, pid, card.iid);
          if (effect.bind && n <= 1)
            ctx.bindings[effect.bind] = { ...card, _pid: pid, cost: DB[card.card_id]?.cost ?? 0 };
        }
        if (n > 1) return { continue: true, queue: [{ ...effect, n: n - 1 }] };
        return { continue: true };
      }

      const hand = b[pid].zones.hand;
      const pool = effect.filter ? hand.filter(r => matchFilter(r, effect.filter, b, ctx)) : [...hand];
      if (pool.length === 0) return { continue: true }; 

      return {
        continue: false,
        choice_needed: {
          kind: 'choose_card_in_hand',
          bind_to: TEMP_BIND,
          bind_pid: pid,
          prompt: `Choose a card to discard${n > 1 ? ` (${n} remaining)` : ''}`,
          available_iids: pool.map(r => r.iid),
        },
      };
    }

    // ─── Gig mutations ──────────────────────────────────────────────────────

    case 'IncreaseGig':
    case 'DecreaseGig':
    case 'AdjustGig':
    case 'SetGigValue': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };
      const amt = evalExpr(effect.amount, b, ctx);
      const list = Array.isArray(bound) ? bound : [bound];
      let lastNewGig = null;
      let lastPid    = null;
      let lastPrev   = null;
      for (const gig of list) {
        let result;
        if      (effect.action === 'IncreaseGig') result = P.increaseGig(b, gig.iid, amt);
        else if (effect.action === 'DecreaseGig') result = P.decreaseGig(b, gig.iid, amt);
        else if (effect.action === 'AdjustGig')   result = P.adjustGig  (b, gig.iid, amt);
        else                                      result = P.setGigValue(b, gig.iid, amt);
        if (!result) continue; 
        const { pid: actualPid, die: newGig, prev: oldValue } = result;

        if (newGig.value !== oldValue && actualPid !== ctx.self_pid) {
          ctx._post_gig_changed = (ctx._post_gig_changed || []).concat([{
            pid: actualPid, iid: gig.iid, old_value: oldValue, new_value: newGig.value,
          }]);
        }
        lastNewGig = newGig;
        lastPid    = actualPid;
        lastPrev   = oldValue;
      }

      if (lastNewGig && effect.target.bind) {
        ctx.bindings[effect.target.bind] = { ...lastNewGig, _pid: lastPid, prev_value: lastPrev };
      }

      return { continue: true };
    }

    case 'RerollGig': {
      const data = ctx.event_data;
      const die  = data && b[data.gig_pid]?.zones?.gigs?.find(g => g.iid === data.gig_iid);
      if (!die) return { continue: true };
      die.value  = 1 + (0 | randFloat(b, `d.${die.iid}.t${b.turn_number}.reroll`) * die.sides);
      data.value = die.value;
      trace(b, `T${b.turn_number}/reroll ${data.gig_pid}#${die.iid} ${die.value}d${die.sides}`);
      return { continue: true };
    }

    case 'TransferGig': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const gig = r.value;
      if (!gig) return { continue: true };
      const dest = effect.to === 'controller' ? ctx.self_pid : P.opponent(ctx.self_pid);
      const moved = P.transferGig(b, gig.iid, dest);
      if (!moved) return { continue: true };   // already at dest, or no longer on the board

      const src = P.findHostOfGear(b, ctx.self_pid, ctx.self_iid) ||
                  P.findOnBoard(b, ctx.self_pid, ctx.self_iid);
      return { continue: true, queue: [{
        action: '_FireSubEvent', event: 'OnStealGigs',
        sub_ctx: {
          source_pid: dest, source_iid: src?.iid, source_card_id: src?.card_id,
          event_data: { stolen_gigs: [{ ...moved, _pid: dest }] },
        },
      }]};
    }

    case 'SwapGig': {
      const ra = _resolveTarget(effect.a, b, ctx);
      
      if (!ra.ok) return { continue: false, choice_needed: ra.halt };
      const rb = _resolveTarget(effect.b, b, ctx);
      
      if (!rb.ok) return { continue: false, choice_needed: rb.halt };
      const gigA = Array.isArray(ra.value) ? ra.value[0] : ra.value;
      const gigB = Array.isArray(rb.value) ? rb.value[0] : rb.value;
      
      if (!gigA || !gigB || gigA.iid === gigB.iid) return { continue: true };
      const pidA = P.findGigOwner(b, gigA.iid);
      const pidB = P.findGigOwner(b, gigB.iid);

      if (!pidA || !pidB || pidA === pidB) {
        trace(b, `T${b.turn_number}/warn SwapGig: gigs not on opposite sides — skipped`);
        return { continue: true };
      }
      const va = b[pidA].zones.gigs.find(g => g.iid === gigA.iid).value;
      const vb = b[pidB].zones.gigs.find(g => g.iid === gigB.iid).value;

      P.transferGig(b, gigA.iid, pidB);
      P.transferGig(b, gigB.iid, pidA);

      trace(b, `T${b.turn_number}/gig swap ${pidA}#${gigA.iid}(${va}) <-> ${pidB}#${gigB.iid}(${vb})`);

      const victim   = pidA === ctx.self_pid ? pidB : pidA;
      const newDie   = pidA === ctx.self_pid ? gigA : gigB;
      const oldValue = pidA === ctx.self_pid ? vb   : va;
      const newValue = pidA === ctx.self_pid ? va   : vb;

      if (victim !== ctx.self_pid && oldValue !== newValue) {
        ctx._post_gig_changed = (ctx._post_gig_changed || []).concat([{
          pid: victim, iid: newDie.iid, old_value: oldValue, new_value: newValue,
        }]);
      }
      return { continue: true };
    }

    // ─── Field mutations ────────────────────────────────────────────────────

    case 'Defeat': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };
      const list = Array.isArray(bound) ? bound : [bound];
      return { continue: true, queue: list.map(u => (
        { action: '_MaybeDefeat', pid: u._pid, iid: u.iid, post: true })) };
    }

    case 'DefeatGear': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };
      const list = Array.isArray(bound) ? bound : [bound];
      for (const g of list) P.defeatGear(b, g._pid, g.iid);
      return { continue: true };
    }

    case 'ReturnToHand': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };
      const list = Array.isArray(bound) ? bound : [bound];
      for (const u of list) P.returnToHand(b, u._pid, u.iid);
      return { continue: true };
    }

    case 'BottomDeckFromField': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };
      // Array-aware so quantifier:'all' works (Towerfall). A single ref becomes
      // a one-element list, so every prior single-target caller is unchanged.
      const list = Array.isArray(bound) ? bound : [bound];
      for (const u of list) P.bottomDeckFromField(b, u._pid, u.iid);
      return { continue: true };
    }

    case 'RemoveFromGame': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (bound) P.removeFromGame(b, bound._pid, bound.iid);
      return { continue: true };
    }

    // ─── State ──────────────────────────────────────────────────────────────

    case 'Spend': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };
      const list = Array.isArray(bound) ? bound : [bound];
      ctx._post_spends = ctx._post_spends || [];
      for (const u of list) {
        P.spendAsset(b, u._pid, u.iid);
        ctx._post_spends.push({ pid: u._pid, iid: u.iid, card_id: u.card_id });
      }
      return { continue: true };
    }
    case 'Ready': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };
      const list = Array.isArray(bound) ? bound : [bound];
      for (const u of list) P.readyAsset(b, u._pid, u.iid);
      return { continue: true };
    }
    case 'SpendSelf': {
      if (ctx.self_iid && ctx.self_pid) {
        P.spendAsset(b, ctx.self_pid, ctx.self_iid);
        ctx._post_spends = ctx._post_spends || [];
        ctx._post_spends.push({ pid: ctx.self_pid, iid: ctx.self_iid, card_id: ctx.self_card_id });
      }
      return { continue: true };
    }
    case 'PayEddies': {
      const n = effect.n !== undefined ? evalExpr(effect.n, b, ctx) : 1;
      if (n <= 0) return { continue: true };
      const spent = P.spendEddies(b[ctx.self_pid], n);
      if (!spent) return { continue: true };            // unaffordable — silent no-op
      if (effect.bind) ctx.bindings[effect.bind] = true;
      return { continue: true, queue: spent.map(r => ({
        action: '_FireSubEvent', event: 'OnSpent',
        sub_ctx: { source_pid: ctx.self_pid, source_iid: r.iid, source_card_id: r.card_id } })) };
    }

    case 'ReadyEddie': {
      const n = effect.n !== undefined ? evalExpr(effect.n, b, ctx) : 1;
      let readied = 0;
      for (const e of b[ctx.self_pid].zones.eddies) {
        if (readied >= n) break;
        if (e.state === 'spent') { e.state = 'ready'; readied++; }
      }
      return { continue: true };
    }

    // ─── Modifiers ──────────────────────────────────────────────────────────

    case 'GrantTempPower': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };
      const amt = evalExpr(effect.amount, b, ctx);
      const list = Array.isArray(bound) ? bound : [bound];
      for (const u of list) P.addTempPower(b, u._pid, u.iid, amt, effect.when);
      return { continue: true };
    }
    case 'GrantTempKeyword': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };
      const list = Array.isArray(bound) ? bound : [bound];
      let until = null;
      if (effect.until === 'controller_next_turn') {
        until = { pid: ctx.self_pid, turn: b.turn_number + 2 };
      } else if (effect.until && effect.until.pid && typeof effect.until.turn === 'number') {
        until = effect.until;
      }
      for (const u of list) P.grantTempKeyword(b, u._pid, u.iid, effect.keyword, until);
      return { continue: true };
    }
    case 'ModifyStealCount': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };
      const amt = evalExpr(effect.amount, b, ctx);
      const list = Array.isArray(bound) ? bound : [bound];
      for (const t of list) {
        const u = P.findOnBoard(b, t._pid, t.iid);
        if (u) u._steal_mod = (u._steal_mod || 0) + amt;
      }
      return { continue: true };
    }

    // ─── Equipment ──────────────────────────────────────────────────────────

    case 'Equip': {
      const rs = _resolveTarget(effect.source, b, ctx);
      if (!rs.ok) return { continue: false, choice_needed: rs.halt };
      const gear = rs.value;
      if (!gear) return { continue: true };

      const rd = _resolveTarget(effect.dest, b, ctx);
      if (!rd.ok) return { continue: false, choice_needed: rd.halt };
      const host = rd.value;
      if (!host) return { continue: true };

      if (gear._host_iid !== undefined) {
        const hostSrc = P.findHostOfGear(b, gear._pid, gear.iid);
        if (hostSrc) {
          const idx = hostSrc.equipped_gear.findIndex(g => g.iid === gear.iid);
          if (idx !== -1) hostSrc.equipped_gear.splice(idx, 1);
        }
      } else if (effect.source.zone === 'hand') {
        const idx = b[gear._pid].zones.hand.findIndex(r => r.iid === gear.iid);
        if (idx !== -1) b[gear._pid].zones.hand.splice(idx, 1);
      }
      P.equipGear(b, host._pid, gear, host.iid);
      return { continue: true };
    }

    // ─── Scheduling ─────────────────────────────────────────────────────────

    case 'ScheduleDefeat': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };
      const list = Array.isArray(bound) ? bound : [bound];
      for (const u of list) P.scheduleDefeat(b, u._pid, u.iid, ctx.self_card_id, effect.condition);
      return { continue: true };
    }

    // ─── Misc ───────────────────────────────────────────────────────────────

    case 'MarkPeeked': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };
      const list = Array.isArray(bound) ? bound : [bound];
      for (const t of list) {
        const u = P.findOnBoard(b, t._pid, t.iid);
        if (u) u._peeked = true;
      }
      return { continue: true };
    }

    case 'CompelAttack': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };
      const list = Array.isArray(bound) ? bound : [bound];
      for (const t of list) {
        const u = P.findOnBoard(b, t._pid, t.iid);
        if (u) u._must_attack_on = b.turn_number + 1;   // the unit's controller's next turn
      }
      return { continue: true };
    }

    case 'CallLegend': {
      if (b[ctx.self_pid]?.called_legend_this_turn) return { continue: true };
      const target = effect.target || {
        bind: '_call_pick', type: 'Legend', side: 'friendly',
        face: 'face_down', chooser: 'controller', optional: true,
      };
      const r = _resolveTarget(target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };

      const leg = b[bound._pid].zones.legends.find(l => l.iid === bound.iid);
      if (!leg || leg.face === 'face_up') return { continue: true };
      leg.face = 'face_up';
      b[bound._pid].called_legend_this_turn = true;

      const subCtx = { source_pid: bound._pid, source_iid: leg.iid, source_card_id: leg.card_id };
      return { continue: true, queue: [
        { action: '_FireSubEvent', event: 'OnCall', sub_ctx: subCtx },
        { action: '_FireSubEvent', event: 'OnFlip', sub_ctx: subCtx },
      ]};
    }

    case 'PlayFromZone': {
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };

      const fromZone = effect.target.zone || 'trash';
      const toZone   = effect.to || 'trash';
      let zoneArr, idx = -1;
      if (fromZone === 'hand_or_trash') {
        for (const z of ['hand', 'trash']) {
          const a = b[bound._pid].zones[z];
          const i = a ? a.findIndex(rr => rr.iid === bound.iid) : -1;
          if (i !== -1) { zoneArr = a; idx = i; break; }
        }
      } else {
        zoneArr = b[bound._pid].zones[fromZone];
        idx = zoneArr ? zoneArr.findIndex(rr => rr.iid === bound.iid) : -1;
      }
      if (idx === -1) return { continue: true };

      let spentForCost = [];
      if (effect.pay_cost) {

        const { effectivePlayCost, consumeNextPlayDiscount } = require('./cost');
        const card = DB[bound.card_id] || {};
        const cost = effectivePlayCost(b, ctx.self_pid, bound, card);
        if (cost > 0) {
          const paid = P.spendEddies(b[ctx.self_pid], cost);
          if (!paid) return { continue: true };
          spentForCost = paid;
        }
        consumeNextPlayDiscount(b, ctx.self_pid, card);
      }

      const [ref] = zoneArr.splice(idx, 1);
      if (DB[ref.card_id]?.type === 'Program')
        b[ctx.self_pid]._played_program_this_turn = true;
      const spentQueue = spentForCost.map(s => ({ action: '_FireSubEvent', event: 'OnSpent',
        sub_ctx: { source_pid: ctx.self_pid, source_iid: s.iid, source_card_id: s.card_id } }));
      const subCtx = { source_pid: bound._pid, source_iid: ref.iid, source_card_id: ref.card_id };

      if (toZone === 'field' && (DB[ref.card_id]?.type === 'Unit')) {
        const unit = { iid: ref.iid, card_id: ref.card_id, state: 'ready', equipped_gear: [], entered_play_turn: b.turn_number };
        return { continue: true, queue: [
          ...spentQueue,
          { action: '_PlaceInZone',  pid: bound._pid, ref: unit, zone: 'field' },
          { action: '_FireSubEvent', event: 'OnPlay',        sub_ctx: subCtx },
          { action: '_FireSubEvent', event: 'OnCardPlayed',  sub_ctx: subCtx },
        ]};
      }

      return { continue: true, queue: [
        ...spentQueue,
        { action: '_FireSubEvent', event: 'OnPlay',        sub_ctx: subCtx },
        { action: '_FireSubEvent', event: 'OnCardPlayed',  sub_ctx: subCtx },
        { action: '_PlaceInZone',  pid: bound._pid, ref, zone: toZone },
      ]};
    }

    case 'PlayGearFromZone': {
      const rg = _resolveTarget(effect.target, b, ctx);
      if (!rg.ok) return { continue: false, choice_needed: rg.halt };
      const gearRef = rg.value;
      if (!gearRef) return { continue: true };

      const dest = effect.dest || { type: 'Unit', side: 'friendly', chooser: 'controller' };
      const rh = _resolveTarget(dest, b, ctx);
      if (!rh.ok) return { continue: false, choice_needed: rh.halt };
      const host = rh.value;
      if (!host) return { continue: true };

      const srcZone = b[gearRef._pid].zones[effect.target.zone || 'hand'];
      const idx = srcZone ? srcZone.findIndex(c => c.iid === gearRef.iid) : -1;
      if (idx === -1) return { continue: true };
      const [ref] = srcZone.splice(idx, 1);
      P.equipGear(b, host._pid, ref, host.iid);

      const subCtx = { source_pid: gearRef._pid, source_iid: ref.iid, source_card_id: ref.card_id };
      return { continue: true, queue: [
        { action: '_FireSubEvent', event: 'OnPlay',       sub_ctx: subCtx },
        { action: '_FireSubEvent', event: 'OnCardPlayed', sub_ctx: subCtx },
      ]};
    }

    case 'RestrictGigSteals': {
      // Board-level, duration-scoped limit on steals from this player's Gig row.
      // forbid 'above_power' (default): attacker may only take Gigs valued <= its
      // power (Chrome Fang). 'below_power': only Gigs valued >= its power
      // (Westbrook Netrunner). `attacker` (CardFilter) scopes which raiders are
      // limited — card-def type, so a GO_SOLO'd Legend is still a Legend.
      const until = effect.until === 'controller_next_turn'
        ? { pid: ctx.self_pid, turn: b.turn_number + 2 }
        : (effect.until && typeof effect.until.turn === 'number' ? effect.until : null);
      const entry = {
        protected_pid: ctx.self_pid,
        forbid:        effect.forbid === 'below_power' ? 'below_power' : 'above_power',
        attacker:      effect.attacker || null,
        until_pid:     until ? until.pid : ctx.self_pid,
        until_turn:    until ? until.turn : b.turn_number + 2,
      };
      const key = e => e.protected_pid + '|' + e.forbid + '|' + JSON.stringify(e.attacker);
      b._steal_power_limits = (b._steal_power_limits || [])
        .filter(e => key(e) !== key(entry));
      b._steal_power_limits.push(entry);
      return { continue: true };
    }

    case 'PreventFightDefeat': {
      b._fight_shield = b._fight_shield || {};
      b._fight_shield[ctx.self_pid] = true;
      return { continue: true };
    }

    case 'DiscountGoSolo': {
      // Targeted, turn-scoped GO SOLO discount (Nocturne OP55 N1): the chosen
      // legend's solo cost drops by `amount`, floored at `min`. Stored on the
      // legend ref, read by events.js goSoloCost, wiped by clearTransients.
      const r = _resolveTarget(effect.target, b, ctx);
      if (!r.ok) return { continue: false, choice_needed: r.halt };
      const bound = r.value;
      if (!bound) return { continue: true };
      const amt = evalExpr(effect.amount, b, ctx);
      const list = Array.isArray(bound) ? bound : [bound];
      for (const l of list) {
        const leg = b[l._pid].zones.legends.find(x => x.iid === l.iid);
        if (leg) leg._solo_discount = { amount: amt, min: effect.min ?? 1 };
      }
      return { continue: true };
    }

    case 'DiscountNextPlay': {
      const discount = Math.max(0, evalExpr(effect.amount, b, ctx));
      b._next_play_discount = {
        pid:    ctx.self_pid,
        filter: effect.filter || null,
        discount,
        min:    effect.min ?? 1,
      };
      return { continue: true };
    }

    case '_FireSubEvent': {
      const { fireEvent } = require('./events');
      const result = fireEvent(b, effect.event, effect.sub_ctx, effect.opts);
      if (result?.halted) return { continue: false, fire_event_halt: result };
      return { continue: true };
    }

    case '_PlaceInZone': {
      const arr = b[effect.pid]?.zones?.[effect.zone];
      if (arr && effect.ref) arr.push(effect.ref);
      return { continue: true };
    }

    // ─── Defeat replacement window ──────────────────────────────────────────
    // Every defeat splits into _MaybeDefeat (opens OnWouldBeDefeated while the
    // unit is still on the field) then _CommitDefeat. A listener may cancel it
    // with PreventPendingDefeat — Jackie Welles pays 1 €$ to die instead.
    // `post` preserves each call site's original OnDefeated timing: the Defeat
    // action defers to the post-effect drain, fight/end-of-turn queue it inline.

    case '_MaybeDefeat': {
      const u = P.findOnBoard(b, effect.pid, effect.iid);
      if (!u) return { continue: true };
      b._pending_defeats = b._pending_defeats || [];
      b._pending_defeats.push({ pid: effect.pid, iid: effect.iid, prevented: false });
      return { continue: true, queue: [
        { action: '_FireSubEvent', event: 'OnWouldBeDefeated',
          sub_ctx: { source_pid: effect.pid, source_iid: effect.iid, source_card_id: u.card_id } },
        { action: '_CommitDefeat', pid: effect.pid, iid: effect.iid, post: !!effect.post },
      ]};
    }

    case '_CommitDefeat': {
      const pending = (b._pending_defeats || []).pop();
      if (pending?.prevented) {
        b._logEvents = b._logEvents || [];
        b._logEvents.push({ msg: `${DB[P.findOnBoard(b, effect.pid, effect.iid)?.card_id]?.name || 'Unit'} is not defeated`, type: 'combat' });
        return { continue: true };
      }
      const d = P.defeatUnit(b, effect.pid, effect.iid);
      if (!d) return { continue: true };
      if (effect.post) {
        ctx._post_defeats = (ctx._post_defeats || []).concat([{ pid: effect.pid, ref: d }]);
        return { continue: true };
      }
      return { continue: true, queue: [{ action: '_FireSubEvent', event: 'OnDefeated',
        sub_ctx: { source_pid: effect.pid, source_iid: d.iid, source_card_id: d.card_id,
                   event_data: { gear_count: (d.equipped_gear || []).length } } }] };
    }

    // ─── Steal replacement window ───────────────────────────────────────────
    // One window per chosen gig, opened while the gig is still in the victim's
    // row. OnStealGigs fires once at the end over the gigs that survived.

    case '_MaybeStealGig': {
      const st = b._steal_pending;
      if (!st) return { continue: true };
      const g = b[st.victim].zones.gigs.find(x => x.iid === effect.gig_iid);
      if (!g) return { continue: true };                 // gone since the pick
      b._pending_steal = { gig_iid: effect.gig_iid, prevented: false };
      return { continue: true, queue: [
        { action: '_FireSubEvent', event: 'OnWouldStealGig',
          sub_ctx: { source_pid: st.pid, source_iid: st.attacker_iid, source_card_id: st.attacker_card_id,
                     event_data: { gig: [{ ...g, _pid: st.victim }], value: g.value, sides: g.sides } } },
        { action: '_CommitStealGig', gig_iid: effect.gig_iid },
      ]};
    }

    case '_CommitStealGig': {
      const pend = b._pending_steal;
      delete b._pending_steal;
      const st = b._steal_pending;
      if (!st || pend?.prevented) return { continue: true };
      const g = P.transferGig(b, effect.gig_iid, st.pid);
      if (g) st.taken.push(g);
      return { continue: true };
    }

    case '_FinishSteal': {
      const st = b._steal_pending;
      delete b._steal_pending;
      if (!st) return { continue: true };
      const attU = P.findOnBoard(b, st.pid, st.attacker_iid);
      if (attU && st.taken.length) {
        attU._combat_this_turn    = true;
        attU._stole_gig_this_turn = true;
      }
      return { continue: true, queue: [
        { action: '_FireSubEvent', event: 'OnStealGigs',
          sub_ctx: { source_pid: st.pid, source_iid: st.attacker_iid, source_card_id: attU?.card_id || st.attacker_card_id,
                     event_data: { stolen_gigs: st.taken.map(g => ({ ...g, _pid: st.pid })) } } },
        { action: '_EndAttack', steal: true },
      ]};
    }

    case 'PreventPendingSteal': {
      if (b._pending_steal) b._pending_steal.prevented = true;
      return { continue: true };
    }

    case 'PreventPendingDefeat': {
      const top = (b._pending_defeats || [])[b._pending_defeats.length - 1];
      if (top) top.prevented = true;
      return { continue: true };
    }

    // ─── Engine-internal continuation actions (not card DSL) ────────────────
    // Fight stages, end-of-turn cleanup, and attack teardown expressed as
    // ordinary queue items, so mid-flow halts resume through the standard
    // effect machinery.

    case '_FightInit': {
      const atk = b.current_attack;
      const pid = b.active_player, opp = P.opponent(pid);
      const attU = b[pid].zones.field.find(u => u.iid === atk.attacker_iid);
      const defU = atk.target.kind === 'unit' ? b[opp].zones.field.find(u => u.iid === atk.target.iid) : null;
      if (!attU || !defU) return { continue: true };   // no fight — later stages no-op on _ap undefined
      const { applyStaticPower, alwaysWinsFight, effectiveKeywords } = require('./events');
      attU._combat_this_turn = true;
      defU._combat_this_turn = true;
      atk._ap           = applyStaticPower(b, pid, attU, { role: 'attacker', during_fight: true, opp_type: DB[defU.card_id]?.type });
      atk._dp           = applyStaticPower(b, opp, defU, { role: 'defender', during_fight: true, opp_type: DB[attU.card_id]?.type });
      atk._att_autowin  = alwaysWinsFight(b, pid, attU, defU.card_id);
      atk._def_autowin  = alwaysWinsFight(b, opp, defU, attU.card_id);
      atk._attU_card_id = attU.card_id;
      atk._defU_card_id = defU.card_id;
      atk._defU_iid     = defU.iid;
      if (b._fight_shield?.[opp]) { delete b._fight_shield[opp]; atk._shielded_def = true; }
      if (b._fight_shield?.[pid]) { delete b._fight_shield[pid]; atk._shielded_att = true; }
      // FIGHT_IMMUNE is per-unit and lasts the turn — unlike _fight_shield it is
      // not consumed, so it holds across every fight the unit is in.
      if (effectiveKeywords(b, opp, defU).includes('FIGHT_IMMUNE')) atk._shielded_def = true;
      if (effectiveKeywords(b, pid, attU).includes('FIGHT_IMMUNE')) atk._shielded_att = true;
      return { continue: true };
    }

    case '_FightDefeat': {
      const atk = b.current_attack;
      if (!atk || atk._ap === undefined) return { continue: true };
      const pid = b.active_player, opp = P.opponent(pid);
      const isDef = effect.role === 'defender';
      const o     = fightOutcome(atk);
      const loses = isDef ? o.defLoses : o.attLoses;
      const side  = isDef ? opp : pid;
      const iid   = isDef ? atk._defU_iid : atk.attacker_iid;
      if (!loses || !iid) return { continue: true };
      if (isDef ? atk._shielded_def : atk._shielded_att) {
        b._logEvents = b._logEvents || [];
        const cid = isDef ? atk._defU_card_id : atk._attU_card_id;
        b._logEvents.push({ msg: `${DB[cid]?.name || 'Unit'} survives the fight (defeat prevented)`, type: 'combat' });
        return { continue: true };
      }

      const otherSide = isDef ? pid : opp;
      const otherIid  = isDef ? atk.attacker_iid : atk._defU_iid;
      const otherCid  = isDef ? atk._attU_card_id : atk._defU_card_id;
      const loserCid  = isDef ? atk._defU_card_id : atk._attU_card_id;
      const queue = [
        { action: '_FireSubEvent', event: 'OnLoseFight',
          sub_ctx: { source_pid: side, source_iid: iid, source_card_id: loserCid,
                     event_data: { opposing: otherIid ? [{ iid: otherIid, card_id: otherCid, _pid: otherSide }] : [] } } },
      ];

      if ((isDef ? atk._ap : atk._dp) > 0) queue.push({ action: '_MaybeDefeat', pid: side, iid });
      return { continue: true, queue };
    }

    case '_FightWin': {
      const atk = b.current_attack;
      if (!atk || atk._ap === undefined) return { continue: true };
      const pid = b.active_player, opp = P.opponent(pid);
      const queue = [];
      const autowin = !!atk._att_autowin !== !!atk._def_autowin;
      const attWon  = autowin ? !!atk._att_autowin : atk._ap > atk._dp;
      const defWon  = autowin ? !!atk._def_autowin : atk._dp > atk._ap;

      if (attWon && b[pid].zones.field.some(u => u.iid === atk.attacker_iid)) {
        queue.push({ action: '_FireSubEvent', event: 'OnWinFight',
          sub_ctx: { source_pid: pid, source_iid: atk.attacker_iid, source_card_id: atk._attU_card_id,
                     event_data: { margin: atk._ap - atk._dp, winner_power: atk._ap, loser_power: atk._dp } } });
      } else if (defWon && atk._defU_iid && b[opp].zones.field.some(u => u.iid === atk._defU_iid)) {
        queue.push({ action: '_FireSubEvent', event: 'OnWinFight',
          sub_ctx: { source_pid: opp, source_iid: atk._defU_iid, source_card_id: atk._defU_card_id,
                     event_data: { margin: atk._dp - atk._ap, winner_power: atk._dp, loser_power: atk._ap } } });
      }
      return { continue: true, queue };
    }

    case '_EndAttack': {
      b.current_attack = null;
      const { checkWin } = require('./rules');
      const winner = effect.steal && b.overtime ? checkWin(b) : null;
      if (winner) b.winner = winner;
      return { continue: true };
    }

    case '_EndTurnCleanup': {
      const items = b.scheduled_effects.splice(0).map(e => ({ action: '_EndTurnDefeat', e }));
      return { continue: true, queue: items };
    }

    case '_EndTurnDefeat': {
      const e = effect.e;
      if (e.kind !== 'defeat_eot') return { continue: true };
      let allowed = true;
      if (e.condition) {
        const u = P.findOnBoard(b, e.pid, e.iid);
        allowed = !!u && evalCondition(e.condition, b,
          { self_pid: e.pid, self_iid: e.iid, self_card_id: u.card_id, bindings: {} });
      }
      const u = allowed ? P.findOnBoard(b, e.pid, e.iid) : null;
      if (!u) return { continue: true };
      if (DB[u.card_id]) {
        b._logEvents = b._logEvents || [];
        const sourceName = e.source_card_id ? DB[e.source_card_id]?.name : null;
        b._logEvents.push({
          msg: sourceName
            ? `End of turn: ${sourceName} defeats ${DB[u.card_id].name}`
            : `End of turn: ${DB[u.card_id].name} defeated`,
          type: 'combat',
        });
      }
      return { continue: true, queue: [{ action: '_MaybeDefeat', pid: e.pid, iid: e.iid }] };
    }

    case '_EndTurnFinish': {
      P.clearTransients(b);
      P.recordTurnEndAndCheckOvertime(b);
      b.active_player = P.opponent(b.active_player);
      b.phase = 'between_turns';
      return { continue: true };
    }

    default:
      trace(b, `T${b.turn_number}/warn unknown action "${effect.action}" skipped`);
      return { continue: true };
  }
}

function _drainPostEffectsToActions(b, ctx) {
  const out = [];

  const gigChanges = ctx._post_gig_changed || [];
  ctx._post_gig_changed = [];
  for (const g of gigChanges) {
    out.push({
      action: '_FireSubEvent',
      event: 'OnGigValueChanged',
      sub_ctx: {
        source_pid: ctx.self_pid || b.active_player,
        event_data: { gig_iid: g.iid, gig_pid: g.pid, old_value: g.old_value, new_value: g.new_value },
      },
    });
  }

  const defeats = ctx._post_defeats || [];
  ctx._post_defeats = [];
  for (const d of defeats) {
    out.push({
      action: '_FireSubEvent',
      event: 'OnDefeated',
      sub_ctx: { source_pid: d.pid, source_iid: d.ref.iid, source_card_id: d.ref.card_id, event_data: { gear_count: (d.ref.equipped_gear || []).length } },
    });
  }

  const spends = ctx._post_spends || [];
  ctx._post_spends = [];
  for (const s of spends) {
    out.push({
      action: '_FireSubEvent',
      event: 'OnSpent',
      sub_ctx: { source_pid: s.pid, source_iid: s.iid, source_card_id: s.card_id },
    });
  }

  return out;
}

function resolveEffects(effects, b, ctx) {
  if (!ctx) return { halted: false };
  ctx.bindings = ctx.bindings || {};
  const queue = Array.isArray(effects) ? [...effects] : [];

  while (true) {
    if (queue.length === 0) {
      const followups = _drainPostEffectsToActions(b, ctx);
      if (followups.length === 0) break;
      queue.push(...followups);
    }

    const frame = queue.shift();
    const r = resolveEffect(frame, b, ctx);
    traceEffect(b, ctx, frame, r);

    if (r.fire_event_halt) {
      return {
        halted: true,
        sub_halted: true,
        fire_event_halt: r.fire_event_halt,
        pending_effects: queue,
        context: ctx,
        choice_needed: r.fire_event_halt.choice_needed,
      };
    }
    if (!r.continue) {
      return {
        halted: true,
        choice_needed: r.choice_needed,
        pending_effects: r.no_repush ? queue : [frame, ...queue],
        context: ctx,
      };
    }
    if (r.queue && r.queue.length) queue.unshift(...r.queue);
  }
  return { halted: false, context: ctx };
}

function resumeEffects(halted, response, b) {
  if (!halted || !halted.pending_effects) return { halted: false };
  const ctx = halted.context;
  ctx.bindings = ctx.bindings || {};

  if (halted.sub_halted && halted.fire_event_halt) {
    const { fireEventResume } = require('./events');
    const inner = fireEventResume(halted.fire_event_halt, response, b);
    if (inner?.halted) {
      return {
        ...halted,
        fire_event_halt: inner,
        choice_needed: inner.choice_needed,
      };
    }
    return resolveEffects(halted.pending_effects, b, ctx);
  }

  const need = halted.choice_needed;
  const bindPid = need.bind_pid;
  const spec = CHOICE_TYPES[need.kind];
  if (!spec) throw new Error(`Unknown choice kind: ${need.kind}`);

  switch (spec.response) {
    case 'iid': {

      if (need.optional && response?.iid == null) {
        ctx.bindings[need.bind_to] = null;
        break;
      }
      if (Array.isArray(need.available_iids) && !need.available_iids.includes(response?.iid))
        throw new Error(`iid ${response?.iid} is not among the offered choices`);
      if (spec.zone === 'equipped') {
        ctx.bindings[need.bind_to] = null;
        for (const p of [bindPid, P.opponent(bindPid)]) {
          const host = P.findHostOfGear(b, p, response.iid);
          if (!host) continue;
          const g = host.equipped_gear.find(x => x.iid === response.iid);
          if (g) { ctx.bindings[need.bind_to] = { ...g, _pid: p, _host_iid: host.iid }; break; }
        }
      } else if (spec.zone === 'in_play') {
        for (const p of [bindPid, bindPid === 'p1' ? 'p2' : 'p1']) {
          const u = P.findOnBoard(b, p, response.iid);
          if (u) { ctx.bindings[need.bind_to] = { ...u, _pid: p }; break; }
        }
      } else if (spec.zone === 'hand_or_trash') {
        for (const z of ['hand', 'trash']) {
          const card = b[bindPid].zones[z]?.find(x => x.iid === response.iid);
          if (card) { ctx.bindings[need.bind_to] = { ...card, _pid: bindPid }; break; }
        }
      } else {
        const card = b[bindPid].zones[spec.zone]?.find(x => x.iid === response.iid);
        if (card) {
          ctx.bindings[need.bind_to] = { ...card, _pid: bindPid };
        } else {
          const otherPid = bindPid === 'p1' ? 'p2' : 'p1';
          const other = b[otherPid].zones[spec.zone]?.find(x => x.iid === response.iid);
          if (other) ctx.bindings[need.bind_to] = { ...other, _pid: otherPid };
        }
      }
      break;
    }
    case 'amount': {
      const n = Number(response?.amount);
      if (!Number.isFinite(n) || n < need.min || n > need.max)
        throw new Error(`Amount ${response?.amount} out of range [${need.min},${need.max}]`);
      if (need.exclude_zero && n === 0)
        throw new Error('Amount cannot be zero');
      if (need.bind_to) ctx.bindings[need.bind_to] = n;
      break;
    }
    case 'accept': {
      if (response.accept !== false) {
        if (need.pending_body?.length) {
          halted = { ...halted, pending_effects: [...need.pending_body, ...halted.pending_effects] };
        }
      } else if (need.otherwise_body?.length) {
        halted = { ...halted, pending_effects: [...need.otherwise_body, ...halted.pending_effects] };
      }
      break;
    }
    case 'card_type': {
      const t = response?.card_type;
      if (!Array.isArray(need.options) || !need.options.includes(t))
        throw new Error(`Card type ${t} is not among the offered options`);
      if (need.bind_to) ctx.bindings[need.bind_to] = t;
      break;
    }
    case 'acknowledge': {
      // The reveal already happened (card is bound); the player just confirms
      // they've seen it. Routing runs in the pending effects after this.
      break;
    }
    case 'selected_iids': {

      if (need.kind === 'choose_units') {
        const eligible = new Set(need.available_iids || []);
        const selected = (response.selected_iids || []).filter(iid => eligible.has(iid));
        if (selected.length > (need.take_up_to ?? Infinity))
          throw new Error(`Cannot select more than ${need.take_up_to} units`);
        const zone = spec.zone || 'field';
        const bindings = [];
        for (const iid of selected) {
          const ref = b[bindPid].zones[zone]?.find(x => x.iid === iid);
          if (ref) bindings.push({ ...ref, _pid: bindPid });
        }
        if (need.bind_to) ctx.bindings[need.bind_to] = bindings;
        break;
      }
      const allRefs  = need.available_refs || [];
      const eligible = new Set(need.eligible_iids || []);
      const selected = (response.selected_iids || []).filter(iid => eligible.has(iid));
      if (selected.length > need.take_up_to)
        throw new Error(`Cannot select more than ${need.take_up_to} cards`);
      if (selected.length < (need.take_min || 0))
        throw new Error(`Must select at least ${need.take_min} card${need.take_min !== 1 ? 's' : ''}`);
      const selectedSet = new Set(selected);
      const kept = allRefs.filter(r => selectedSet.has(r.iid));
      const rest = allRefs.filter(r => !selectedSet.has(r.iid));
      if (allRefs.length) {
        b._reveals = b._reveals || [];
        b._reveals.push({
          pid:      bindPid,
          revealed: allRefs.map(r => r.card_id),
          picked:   kept.map(r => r.card_id),
        });
      }
      if (need.scry_trash) {
        for (const ref of kept) b[bindPid].zones.trash.push(ref);   // selected → trash
        b[bindPid].zones.deck.unshift(...rest);                     // unselected → top, in order
        break;
      }
      for (const ref of kept) b[bindPid].zones.hand.push(ref);
      if (need.trash_remainder) {
        b[bindPid].zones.trash.push(...rest);
      } else {
        b[bindPid].zones.deck.push(...shuffle(b, rest));
      }
      break;
    }
  }

  return resolveEffects(halted.pending_effects, b, ctx);
}

module.exports = {
  resolveEffects,
  resumeEffects,
};
