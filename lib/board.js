'use strict';

const { DB } = require('./cards');

const act    = b => b[b.active_player];
const def    = b => b[b.active_player === 'p1' ? 'p2' : 'p1'];

const ended   = b       => ({ status: 'ended',   board: b, waitingFor: null });
const waiting = (b, wf) => (b.winner ? ended(b) : { status: 'waiting', board: b, waitingFor: wf });

function haltToWaiting(b, frameKind, haltedState, defaultOwner) {
  b.effect_stack.push({ kind: frameKind, halted_state: haltedState });
  const cn = haltedState.choice_needed;
  return waiting(b, {
    step: 'effect_choice',
    owner: cn?.chooser_pid || cn?.bind_pid || defaultOwner || b.active_player,
    choice_needed: cn,
  });
}

function availDice(p) {
  const nonD20 = p.zones.fixer.filter(d => d.sides !== 20).map(d => d.sides);
  if (nonD20.length) return nonD20;
  return p.zones.fixer.find(d => d.sides === 20) ? [20] : [];
}

function getCard(card_id) {
  const c = DB[card_id];
  if (!c) throw new Error(`Unknown card: ${card_id}`);
  return c;
}

module.exports = {
  act, def, waiting, ended, haltToWaiting,
  availDice,
  getCard,
};
