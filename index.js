'use strict';

const { step, defaultPassAction } = require('./lib/turn');
const { validateDeck, deckIsIllegal, setupGame } = require('./lib/setup');
const { evalExpr } = require('./lib/eval');
const { effectiveKeywords, goSoloCost, legendCallCost, applyStaticPower } = require('./lib/events');
const { legendSpendable } = require('./lib/primitives');
const { effectivePlayCost } = require('./lib/cost');
const { cleanBoardForExternal, disableTrace } = require('./lib/trace');

const { CARDS, CARD_SCRIPTS } = require('./lib/cards');
const CHOICE_TYPES = require('./data/choice-types.json');

module.exports = {
  step, setupGame, validateDeck, deckIsIllegal, evalExpr, effectiveKeywords,
  effectivePlayCost, goSoloCost, legendCallCost, applyStaticPower, legendSpendable,
  cleanBoardForExternal, disableTrace,
  defaultPassAction,
  CARDS, CARD_SCRIPTS, CHOICE_TYPES,
}; 
