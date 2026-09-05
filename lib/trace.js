'use strict';

const MAX_FRAMES = 500;

const SUMMARY_KEYS = ['n', 'amount', 'keyword', 'side', 'to', 'take_up_to', 'cost_eq'];

function traceInit(b) {
  b._trace = [];
}

function disableTrace(b) {
  b._trace = null;
}

function cleanBoardForExternal(b) {
  if (!b) return b;
  const { _trace, _rngMap, _rng_seq, _rngState, _card_count, ...rest } = b;
  return rest;
}

function trace(b, line) {
  if (!b || !b._trace) return;
  b._trace.push(line);
  if (b._trace.length > MAX_FRAMES) b._trace.splice(0, b._trace.length - MAX_FRAMES);
}

function fmtArgs(effect) {
  const parts = [];
  for (const k of SUMMARY_KEYS) {
    const v = effect[k];
    if (v === undefined) continue;
    parts.push(`${k}:${typeof v === 'object' ? '…' : v}`);
  }
  if (effect.target) {
    const t = effect.target;
    const brief = t.from_self ? 'self'
                : t.from_host ? 'host'
                : t.from_trigger_source ? 'trig_src'
                : t.from_binding ? `$${t.from_binding}`
                : (t.side || 'self') + '.' + (t.type || t.zone || '?');
    parts.push(`tgt:${brief}`);
  }
  return parts.length ? `{${parts.join(',')}}` : '';
}

function fmtCtx(b, ctx) {
  const t   = b.turn_number ?? 0;
  const ph  = ctx.event ? 'trig' : (b.phase || '?').slice(0, 4);
  const pid = ctx.self_pid || '??';
  const cid = ctx.self_card_id || '?';
  const iid = ctx.self_iid != null ? `#${ctx.self_iid}` : '';
  return `T${t}/${ph} ${pid}/${cid}${iid}`;
}

function traceEffect(b, ctx, effect, result) {
  const head    = fmtCtx(b, ctx);
  const args    = fmtArgs(effect);
  const outcome = result.continue ? 'ok' : `HALT:${result.choice_needed?.kind || '?'}`;
  trace(b, `${head} ${effect.action}${args} ${outcome}`);
}

function traceEventFired(b, event, baseCtx) {
  const t   = b.turn_number ?? 0;
  const pid = baseCtx.source_pid || '-';
  const cid = baseCtx.source_card_id || '-';
  const iid = baseCtx.source_iid != null ? `#${baseCtx.source_iid}` : '';
  trace(b, `T${t}/evt ${pid}/${cid}${iid} ${event}`);
}

function traceListener(b, event, pid, ref, outcome) {
  const t = b.turn_number ?? 0;
  trace(b, `T${t}/lis ${pid}/${ref.card_id}#${ref.iid} ${event} ${outcome}`);
}

module.exports = { traceInit, disableTrace, cleanBoardForExternal, trace, traceEffect, traceEventFired, traceListener };
