'use strict';

const { fireEventResume, fireOrHalt, fireEventChain, effectiveKeywords, goSoloCost, legendCallCost } = require('./events');
const { resolveEffects, resumeEffects } = require('./effects');
const { trace } = require('./trace');
const { randFloat } = require('./rng');
const { effectivePlayCost, consumeNextPlayDiscount } = require('./cost');
const P = require('./primitives');

const {
  act, def, waiting, ended, haltToWaiting,
  availDice, getCard,
} = require('./board');
const { checkWin, canUnitAttack, hasAttackTarget } = require('./rules');
const { FIRST_READY_TURN } = require('./constants');

const {
  mainWaiting, afterChain, declareAttack, handleDefensive, handleAttackerInterrupt,
  handleStealChoice, resolveSpendActivated, playProgram,
} = require('./combat');

const rollDie = (b, die) => 1 + (0 | randFloat(b, `d.${die.iid}.t${b.turn_number}`) * die.sides);

// ─── MAIN-PHASE HELPERS ──────────────────────────────────────────────────────

function _resolveAnytimeSpend(b, input) {
  return resolveSpendActivated(b, input, b.active_player, { window: 'Anytime' });
}

function _fireEventsWithSpends(b, pid, spentLegends, events, ctx) {
  if (!spentLegends || !spentLegends.length) {
    return fireEventChain(b, events, ctx, pid);
  }
  const chain = [
    ...spentLegends.map(r => ({
      action: '_FireSubEvent', event: 'OnSpent',
      sub_ctx: { source_pid: pid, source_iid: r.iid, source_card_id: r.card_id },
    })),
    ...events.map(event => ({ action: '_FireSubEvent', event, sub_ctx: ctx })),
  ];
  const res = resolveEffects(chain, b, { bindings: {} });
  if (res.halted) return haltToWaiting(b, 'resume_effects', res, pid);
  return null;
}

function _resolveChoiceResponse(b, input, defaultOwner) {
  const frame = b.effect_stack.pop();
  if (!frame) throw new Error('No halted effect to resume');

  const choiceStr = input.response ? JSON.stringify(input.response) : 'skip';
  trace(b, `T${b.turn_number}/choice ${defaultOwner} ${choiceStr}`);

  const result = frame.kind === 'resume_fire_event'
    ? fireEventResume(frame.halted_state, input.response, b)
    : resumeEffects(frame.halted_state, input.response, b);

  if (!result?.halted) return null;
  return haltToWaiting(b, frame.kind, result, defaultOwner);
}

// ─── START PHASE ─────────────────────────────────────────────────────────────
function beginTurn(b) {
  b.turn_number += 1;
  b.phase = 'start';
  def(b).called_legend_defensive_this_turn = false;
  act(b).took_gig_this_turn = false;

  P.clearExpiredUntilKeywords(b, b.active_player);

  b.rate_limits[b.active_player] = {};

  const winner = checkWin(b);
  if (winner) { b.winner = winner; return ended(b); }

  if (b.turn_number >= FIRST_READY_TURN) P.readyAll(b, b.active_player);
  P.draw(b, b.active_player);
  if (b.winner) return ended(b);

  const avail = availDice(act(b));
  if (!avail.length) {
    act(b).called_legend_this_turn = false;
    act(b).sold_card_this_turn = false;
    b.phase = 'main';
    const w = fireOrHalt(b, 'OnPlayPhaseStart', { source_pid: b.active_player }, b.active_player);
    if (w) return w;
    return mainWaiting(b);
  }
  return waiting(b, { step: 'choose_gig_die', owner: b.active_player, available: avail });
}

function stepStart(b, input) {
  if (!input)
    return waiting(b, { step: 'choose_gig_die', owner: b.active_player, available: availDice(act(b)) });
  if (input.step !== 'choose_gig_die') throw new Error(`Unexpected start input: ${input.step}`);

  const p   = act(b);
  const idx = p.zones.fixer.findIndex(d => d.sides === input.sides);
  if (idx === -1) throw new Error(`d${input.sides} not available in fixer`);

  const [die] = p.zones.fixer.splice(idx, 1);
  die.value = rollDie(b, die);
  die.origin_pid = b.active_player;
  p.zones.gigs.push(die);
  p.took_gig_this_turn = true;

  p.called_legend_this_turn = false;
  p.sold_card_this_turn     = false;
  b.phase = 'main';

  const chain = [
    { action: '_FireSubEvent', event: 'OnGigRolled',
      sub_ctx: { source_pid: b.active_player,
                 event_data: { gig_iid: die.iid, gig_pid: b.active_player, sides: die.sides, value: die.value } } },
    { action: '_FireSubEvent', event: 'OnPlayPhaseStart',
      sub_ctx: { source_pid: b.active_player } },
  ];
  const res = resolveEffects(chain, b, { bindings: {} });
  if (res.halted) return haltToWaiting(b, 'resume_effects', res, b.active_player);
  return mainWaiting(b);
}

// ─── MAIN PHASE ──────────────────────────────────────────────────────────────

function stepMain(b, input) {
  const pid = b.active_player;
  const p   = act(b);

  if (input?.step === 'effect_choice_response') {
    const halted = _resolveChoiceResponse(b, input, pid);
    if (halted) return halted;
    if (b.winner) return ended(b);
    if (b.phase === 'between_turns') return step(b, undefined);   // turn ended mid-chain
    return afterChain(b);
  }

  if (b.current_attack) {
    if (b.current_attack.step === 'attacker_interrupt') return handleAttackerInterrupt(b, input);
    if (b.current_attack.step === 'defensive')          return handleDefensive(b, input);
    if (b.current_attack.step === 'choosing_gig')       return handleStealChoice(b, input);
  }

  // A pending choice frame means the only legal input was an effect_choice_response
  // (handled above) or a combat sub-step (handled above). Any other input would
  // bypass the choice and orphan its frame, so reject it instead.
  if (b.effect_stack.length > 0)
    throw new Error('Resolve the pending choice before taking another action');

  if (!input || input.step === 'end_turn') return endTurn(b);

  switch (input.step) {

    case 'declare_attack':
      return declareAttack(b, input.attacker_iid, input.target);

    case 'tap_resource': {
      const { iid } = input;
      const isEddie  = p.zones.eddies.some(e => e.iid === iid && e.state === 'ready');
      const isLegend = p.zones.legends.some(l => l.iid === iid && l.state === 'ready' && P.legendSpendable(l));
      if (!isEddie && !isLegend) throw new Error('That card cannot be tapped');
      const idx = p.tapped.indexOf(iid);
      if (idx === -1) p.tapped.push(iid);
      else            p.tapped.splice(idx, 1);
      return mainWaiting(b);
    }

    case 'untap_resource': {
      p.tapped = p.tapped.filter(id => id !== input.iid);
      return mainWaiting(b);
    }

    case 'sell_card': {
      if (p.sold_card_this_turn) throw new Error('Already sold a card this turn');
      const idx = p.zones.hand.findIndex(c => c.iid === input.iid);
      if (idx === -1) throw new Error('Card not in hand');
      const c = getCard(p.zones.hand[idx].card_id);
      if (!c.eddie) throw new Error(`${c.name} has no sell tag`);
      const [ref] = p.zones.hand.splice(idx, 1);
      p.zones.eddies.push({ iid: ref.iid, card_id: ref.card_id, state: 'ready' });
      p.sold_card_this_turn = true;
      return mainWaiting(b);
    }

    case 'call_legend': {
      if (p.called_legend_this_turn) throw new Error('Already called a legend this turn');
      const callCost = legendCallCost(b, pid);
      const spentLegends = callCost > 0 ? P.spendTapped(p, callCost) : [];
      const leg = p.zones.legends.find(l => l.iid === input.iid);
      if (!leg || leg.face === 'face_up') throw new Error('Invalid legend target');
      leg.face = 'face_up';
      p.called_legend_this_turn = true;
      const _legCtx = { source_pid: pid, source_iid: leg.iid, source_card_id: leg.card_id };
      const w = _fireEventsWithSpends(b, pid, spentLegends, ['OnCall', 'OnFlip'], _legCtx);
      if (w) return w;
      return mainWaiting(b);
    }

    case 'play_card': {
      const idx = p.zones.hand.findIndex(c => c.iid === input.iid);
      if (idx === -1) throw new Error('Card not in hand');
      const ref = p.zones.hand[idx];
      const c   = getCard(ref.card_id);
      const effCost = effectivePlayCost(b, pid, ref, c);
      const spentLegends = effCost > 0 ? P.spendTapped(p, effCost) : [];
      consumeNextPlayDiscount(b, pid, c);   // play committed — the one-shot discount is used
      p.zones.hand.splice(idx, 1);

      if (c.type === 'Unit') {
        const unit = { iid: ref.iid, card_id: ref.card_id, state: 'ready', equipped_gear: [], entered_play_turn: b.turn_number };
        p.zones.field.push(unit);
        const _uCtx = { source_pid: pid, source_iid: unit.iid, source_card_id: unit.card_id };
        const w = _fireEventsWithSpends(b, pid, spentLegends, ['OnPlay', 'OnCardPlayed'], _uCtx);
        if (w) return w;

      } else if (c.type === 'Program') {
        const w = playProgram(b, pid, ref, spentLegends);
        if (w) return w;

      } else if (c.type === 'Gear') {
        if (!input.equip_to) throw new Error('Gear requires equip_to');

        const host = p.zones.field.find(u => u.iid === input.equip_to) ||
                     p.zones.legends.find(l => l.iid === input.equip_to && l.face === 'face_up');
        if (!host) throw new Error('Host unit/legend not found or not face-up');
        host.equipped_gear = host.equipped_gear || [];
        host.equipped_gear.push({ iid: ref.iid, card_id: ref.card_id });
        const _gCtx = { source_pid: pid, source_iid: ref.iid, source_card_id: ref.card_id };
        const w = _fireEventsWithSpends(b, pid, spentLegends, ['OnPlay', 'OnCardPlayed'], _gCtx);
        if (w) return w;
      }

      return mainWaiting(b);
    }

    case 'play_legend_solo': {
      const leg = p.zones.legends.find(l => l.iid === input.iid);
      if (!leg)                      throw new Error('Legend not found');
      if (leg.face !== 'face_up')    throw new Error('Legend must be face-up to play solo');
      if (leg.state !== 'ready')     throw new Error('Legend must be ready (untapped) to play solo');
      const kw = effectiveKeywords(b, pid, leg);
      if (!kw.includes('GO_SOLO'))   throw new Error('Legend does not have GO SOLO');

      getCard(leg.card_id);                       // validates the card is known
      const soloCost = goSoloCost(b, pid, leg);   // printed cost + any SoloCostTax
      const spentLegends = soloCost > 0 ? P.spendTapped(p, soloCost) : [];

      const lidx = p.zones.legends.indexOf(leg);
      p.zones.legends.splice(lidx, 1);
      const unit = {
        iid:               leg.iid,
        card_id:           leg.card_id,
        state:             'ready',
        equipped_gear:     leg.equipped_gear || [],
        entered_play_turn: b.turn_number,
        from_solo:         true
      };
      p.zones.field.push(unit);

      const _sCtx = { source_pid: pid, source_iid: unit.iid, source_card_id: unit.card_id };
      const w = _fireEventsWithSpends(b, pid, spentLegends, ['OnPlay', 'OnCardPlayed'], _sCtx);
      if (w) return w;
      return mainWaiting(b);
    }

    case 'activate_anytime_spend':
      return _resolveAnytimeSpend(b, input);

    default:
      throw new Error(`Unexpected main input: ${input.step}`);
  }
}

// ─── END OF TURN ─────────────────────────────────────────────────────────────

function endTurn(b) {

  const compelled = b[b.active_player].zones.field.find(
    u => u._must_attack_on === b.turn_number && canUnitAttack(u, b, b.active_player)
      && hasAttackTarget(b, u, b.active_player));
  if (compelled) throw new Error('A compelled unit must attack before you can end your turn');

  const res = resolveEffects([
    { action: '_FireSubEvent', event: 'OnEndTurn', sub_ctx: { source_pid: b.active_player } },
    { action: '_EndTurnCleanup' },
    { action: '_EndTurnFinish' },
  ], b, { bindings: {} });
  if (res.halted) return haltToWaiting(b, 'resume_effects', res, b.active_player);
  return step(b, undefined);
}

// ─── DISPATCHER ──────────────────────────────────────────────────────────────

function _checkCardConservation(b) {
  if (!b._trace || b.effect_stack.length !== 0) return;
  const n = P.countBoardRefs(b);
  if (b._card_count === undefined) { b._card_count = n; return; }
  if (n !== b._card_count) {
    trace(b, `T${b.turn_number}/warn card-count drift ${b._card_count}->${n}`);
    b._card_count = n;
  }
}

function step(board, input) {
  const b = structuredClone(board);
  _checkCardConservation(b);
  if (b.phase === 'between_turns') return beginTurn(b);
  switch (b.phase) {
    case 'start': return stepStart(b, input);
    case 'main':  return stepMain(b, input);
  }
  return ended(b);
}

function defaultPassAction(waitingFor) {
  switch (waitingFor?.step) {
    case 'main_phase':              return { step: 'end_turn' };
    case 'defensive_step':          return { step: 'pass_defensive' };
    case 'attacker_interrupt_step': return { step: 'pass_attacker_interrupt' };
    default:                        return null;
  }
}

module.exports = { step, defaultPassAction };
