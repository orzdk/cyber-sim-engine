#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const { setupGame, step, validateDeck, cleanBoardForExternal, defaultPassAction, CARDS, CARD_SCRIPTS } = require(path.resolve(__dirname, '..'));

// ─── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

const opts = {
  deck1: null, deck2: null,
  bot1:  '../cyber-sim-sdk/server-ai-mybot-min.js',
  bot2:  '../cyber-sim-sdk/server-ai-mybot-min.js',
  first: null,
  turnCap: 200,
  stepCap: 10000,
  runCount: 1,
  trace: false,
  seed: undefined,
};

for (let i = 0; i < args.length; i++) {
  const a = args[i], next = args[i+1];
  if (a === '--deck1'    && next) opts.deck1    = (i++, next);
  else if (a === '--deck2'    && next) opts.deck2    = (i++, next);
  else if (a === '--bot1'     && next) opts.bot1     = (i++, next);
  else if (a === '--bot2'     && next) opts.bot2     = (i++, next);
  else if (a === '--first'    && next) opts.first    = (i++, next);
  else if (a === '--turn-cap' && next) opts.turnCap  = (i++, parseInt(next, 10));
  else if (a === '--step-cap' && next) opts.stepCap  = (i++, parseInt(next, 10));
  else if (a === '--runcount' && next) opts.runCount = (i++, parseInt(next, 10));
  else if (a === '--seed'     && next) opts.seed     = (i++, parseInt(next, 10));
  else if (a === '--trace')            opts.trace    = true;
}
if (!opts.deck1 || !opts.deck2) {
  console.error('usage: node runtime/play.js --deck1 <path> --deck2 <path> [--bot1 path] [--bot2 path] [--first p1|p2] [--turn-cap N] [--step-cap N] [--runcount N] [--seed N] [--trace]');
  process.exit(2);
}

// ─── db / scripts ──────────────────────────────────────────────────────────
const db      = Object.fromEntries(CARDS.map(c => [c.number, c]));
const scripts = Object.fromEntries(CARD_SCRIPTS.map(s => [s.card_id, s]));

// ─── deck parser (.deck text format, e.g. `3x102` or `1xα006`) ─────────────
function parseDeck(filePath) {
  const legends = [], cards = [];
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const m = line.trim().match(/^(\d+)x\s*([Aα])?(.+)$/);
    if (!m) continue;
    const card_id = (m[2] ? 'α' : '') + m[3];
    const count   = parseInt(m[1], 10);
    const c = db[card_id];
    if (!c) { console.warn(`  unknown card: ${card_id}`); continue; }
    if (c.type === 'Legend') for (let i = 0; i < count; i++) legends.push(card_id);
    else cards.push({ card_id, count });
  }
  return { legends, cards };
}

// ─── bot loader — grab the first exported function/class ───────────────────
function loadBot(botPath) {
  const abs = path.resolve(botPath);
  if (!fs.existsSync(abs)) {
    console.error(`bot not found: ${abs}

Expected cyber-sim-sdk and cyber-sim-engine as sibling folders.
If you downloaded zips from GitHub, rename them to drop the -main suffix:
  cyber-sim-engine-main → cyber-sim-engine
  cyber-sim-sdk-main    → cyber-sim-sdk
Or pass --bot1 / --bot2 explicitly.`);
    process.exit(2);
  }
  const mod = require(abs);
  if (typeof mod === 'function') return mod;
  for (const v of Object.values(mod)) if (typeof v === 'function') return v;
  throw new Error(`no class/function export in ${botPath}`);
}

function instantiate(BotCtor, label, pid) {
  const bot = new BotCtor({ name: label });
  bot.pid = pid;
  bot.db = db; bot.scripts = scripts;
  bot.log = () => {}; bot.error = () => {};
  return bot;
}

// ─── run ───────────────────────────────────────────────────────────────────
const deck1 = parseDeck(opts.deck1);
const deck2 = parseDeck(opts.deck2);

for (const [label, d] of [['deck1', deck1], ['deck2', deck2]]) {
  const v = validateDeck(d);
  if (v.errors.length) {
    console.error(`${label} invalid:\n  ${v.errors.join('\n  ')}`);
    process.exit(2);
  }
}

const BotCtor1 = loadBot(opts.bot1);
const BotCtor2 = loadBot(opts.bot2);

function firstFromSeed(seed) { return seed % 2 === 0 ? 'p1' : 'p2'; }

function runOneGame(firstPlayer, seed, trace = null) {
  const bots = {
    p1: instantiate(BotCtor1, 'p1', 'p1'),
    p2: instantiate(BotCtor2, 'p2', 'p2'),
  };
  let { board, waitingFor } = step(setupGame(deck1, deck2, firstPlayer, { seed }), undefined);
  let steps = 0;
  while (board && !board.winner) {
    steps++;
    if ((board.turn_number || 0) > opts.turnCap) return { winner: null, turns: board.turn_number, steps, board, error: 'turn_cap' };
    if (steps > opts.stepCap) return { winner: null, turns: board.turn_number, steps, board, error: 'step_cap' };
    if (!waitingFor) break;

    const owner = waitingFor.owner || board.active_player;
    bots[owner].gameData = { board }; 

    if (trace) trace({ kind: 'recv', n: steps, turn: board.turn_number, phase: board.phase, owner, waitingFor, board: cleanBoardForExternal(board) });

    let botAction = null;
    try { botAction = bots[owner].selectAction(waitingFor, board); }
    catch (e) { return { winner: null, turns: board.turn_number, steps, board, error: `bot_threw:${e.message}` }; }

    let action = botAction || defaultPassAction(waitingFor);
    if (!action) {
      let detail = waitingFor.step;
      if (waitingFor.step === 'effect_choice') {
        const cn = waitingFor.choice_needed || {};
        detail += `:${cn.kind || '?'}`;
        if (cn.source_card_id) detail += `@${cn.source_card_id}`;
      }
      if (trace) trace({ kind: 'error', n: steps, error: `no_fallback:${detail}` });
      return { winner: null, turns: board.turn_number, steps, board, error: `no_fallback:${detail}` };
    }

    if (trace) trace({ kind: 'send', n: steps, owner, action, source: botAction ? 'bot' : 'fallback' });

    try { ({ board, waitingFor } = step(board, action)); }
    catch (e) {
      if (trace) trace({ kind: 'error', n: steps, error: `engine:${e.message}` });
      return { winner: null, turns: board.turn_number, steps, board, error: `engine:${e.message}` };
    }
  }
  return { winner: board?.winner || null, turns: board?.turn_number || 0, steps, board };
}

// ─── trace stream — first game only, regardless of runcount ────────────────
const TRACE_FILE = path.resolve(__dirname, 'play.trace.jsonl');
let _traceStream = fs.createWriteStream(TRACE_FILE);
const _trace = obj => { _traceStream.write(JSON.stringify(obj) + '\n'); };
function _openTraceForFirstGame(firstPlayer) {
  _trace({
    kind: 'config',
    bot1: opts.bot1, bot2: opts.bot2,
    deck1: opts.deck1, deck2: opts.deck2,
    firstPlayer, runCount: opts.runCount, turnCap: opts.turnCap, stepCap: opts.stepCap,
  });
  return _trace;
}
function _closeTrace(res) {
  _trace({ kind: 'game_end', winner: res.winner, turns: res.turns, steps: res.steps, error: res.error });
  _traceStream.end();
  _traceStream = null;
  console.log(`(first-game trace: ${TRACE_FILE})`);
}

const N = opts.runCount;

console.log(`bot1 = ${opts.bot1}`);
console.log(`bot2 = ${opts.bot2}`);
console.log(`deck1 = ${opts.deck1}  deck2 = ${opts.deck2}`);
console.log(`first = ${opts.first || 'random'}  turn_cap = ${opts.turnCap}  step_cap = ${opts.stepCap}  runs = ${N}`);
console.log('');

if (N === 1) {
  const firstPlayer = opts.first || (opts.seed !== undefined ? firstFromSeed(opts.seed) : (Math.random() < 0.5 ? 'p1' : 'p2'));
  const tracer = _openTraceForFirstGame(firstPlayer);
  const res = runOneGame(firstPlayer, opts.seed, tracer);
  _closeTrace(res);
  console.log(`\nwinner: ${res.winner || '(none)'}`);
  console.log(`turns:  ${res.turns}    steps: ${res.steps}`);
  console.log(`p1 gigs: ${res.board?.p1?.zones?.gigs?.length || 0}    p2 gigs: ${res.board?.p2?.zones?.gigs?.length || 0}`);
  if (res.error) console.log(`error: ${res.error}`);
  if (opts.trace && res.board?._trace) {
    console.log('\n─── trace ───');
    for (const t of res.board._trace) console.log(t);
  }
} else {
  const stats = { p1Wins: 0, p2Wins: 0, noWinner: 0, errors: 0, errorBuckets: {}, totalTurns: 0, totalSteps: 0, p1First: 0, p2First: 0 };
  const t0 = Date.now();
  const PROGRESS_EVERY = Math.max(1, Math.floor(N / 20));

  for (let r = 0; r < N; r++) {
    const seed = opts.seed;
    const firstPlayer = opts.first || (seed !== undefined ? firstFromSeed(seed) : (Math.random() < 0.5 ? 'p1' : 'p2'));
    if (firstPlayer === 'p1') stats.p1First++; else stats.p2First++;
    const tracer = r === 0 ? _openTraceForFirstGame(firstPlayer) : null;
    const res = runOneGame(firstPlayer, seed, tracer);
    if (r === 0) _closeTrace(res);
    if (res.error)                       { stats.errors++; stats.errorBuckets[res.error] = (stats.errorBuckets[res.error] || 0) + 1; }
    else if (res.winner === 'p1')        stats.p1Wins++;
    else if (res.winner === 'p2')        stats.p2Wins++;
    else                                 stats.noWinner++;
    stats.totalTurns += res.turns;
    stats.totalSteps += res.steps;
    if ((r + 1) % PROGRESS_EVERY === 0) process.stderr.write(`  ${r + 1}/${N}\n`);
  }

  const elapsed = (Date.now() - t0) / 1000;
  const pct = n => (100 * n / N).toFixed(1).padStart(5);
  console.log(`\nResults over ${N} games (${elapsed.toFixed(1)}s, ${(N/elapsed).toFixed(0)} games/sec):`);
  console.log(`  p1 wins:    ${String(stats.p1Wins).padStart(6)}   ${pct(stats.p1Wins)}%`);
  console.log(`  p2 wins:    ${String(stats.p2Wins).padStart(6)}   ${pct(stats.p2Wins)}%`);
  if (stats.noWinner) console.log(`  no winner:  ${String(stats.noWinner).padStart(6)}   ${pct(stats.noWinner)}%`);
  if (stats.errors) {
    console.log(`  errors:     ${String(stats.errors).padStart(6)}   ${pct(stats.errors)}%`);
    for (const [msg, count] of Object.entries(stats.errorBuckets).sort((a,b) => b[1]-a[1])) {
      console.log(`    ${msg}: ${count}`);
    }
  }
  console.log(`  avg turns:  ${(stats.totalTurns/N).toFixed(1)}`);
  console.log(`  avg steps:  ${(stats.totalSteps/N).toFixed(1)}`);
  if (!opts.first) {
    console.log(`  first-player split:  p1 ${stats.p1First}  /  p2 ${stats.p2First}`);
  }
}
