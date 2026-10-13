// Throughput and usage figures derived from a session's transcript. Pure, so
// the webview computes them on render and tests run them against fixtures.
// Nothing here asks the server for more than the transcript already holds.

import type { AssistantMessage, Message, SessionView, StepTokens, ToolBlock } from "./model";

/** Below these a rate is mostly noise from event batching. */
const MIN_GEN_MS = 250;
const MIN_OUTPUT = 16;
const MIN_PREFILL_TOKENS = 256;

export interface StepRate {
  /** Generated tokens per second, first token to end of stream. */
  decode?: number;
  /** Uncached input tokens per second until the first token. */
  prefill?: number;
  /** Request sent to first token, ms. Includes server-side plugin hooks. */
  ttft?: number;
}

export function stepRate(m: AssistantMessage): StepRate {
  const t = m.timing;
  if (!t?.firstToken) return {};
  const out: StepRate = { ttft: Math.max(0, t.firstToken - t.start) };
  const tok = m.tokens;
  if (tok && t.end) {
    const gen = t.end - t.firstToken;
    const n = tok.output + tok.reasoning;
    if (gen >= MIN_GEN_MS && n >= MIN_OUTPUT) out.decode = n / (gen / 1000);
  }
  if (tok && out.ttft! > 0 && tok.input >= MIN_PREFILL_TOKENS) out.prefill = tok.input / (out.ttft! / 1000);
  return out;
}

export interface TurnSummary {
  steps: number;
  output: number;
  /** Wall time of the turn's model calls and the tools between them, ms. */
  elapsed: number;
  decode?: number;
}

/** One turn: the assistant steps answering a single prompt. */
export function turnSummary(steps: AssistantMessage[]): TurnSummary | undefined {
  const timed = steps.filter((m) => m.timing);
  if (!timed.length) return undefined;
  const first = timed[0].timing!.start;
  const last = Math.max(...timed.map((m) => m.timing!.end ?? m.timing!.firstToken ?? m.timing!.start));
  const agg = aggregateDecode(steps);
  return {
    steps: steps.length,
    output: steps.reduce((a, m) => a + (m.tokens ? m.tokens.output + m.tokens.reasoning : 0), 0),
    elapsed: Math.max(0, last - first),
    decode: agg.rate,
  };
}

/** Token-weighted: total generated tokens over total generating time. */
function aggregateDecode(steps: AssistantMessage[]): { rate?: number; best?: number } {
  let tokens = 0;
  let ms = 0;
  let best: number | undefined;
  for (const m of steps) {
    const r = stepRate(m).decode;
    if (r === undefined) continue;
    tokens += m.tokens!.output + m.tokens!.reasoning;
    ms += m.timing!.end! - m.timing!.firstToken!;
    best = Math.max(best ?? 0, r);
  }
  return { rate: ms ? tokens / (ms / 1000) : undefined, best };
}

export interface ToolCount {
  name: string;
  calls: number;
  errors: number;
}

export interface SessionStats {
  turns: number;
  steps: number;
  tokens: StepTokens;
  /** Share of prompt tokens served from the server's prompt cache, 0..1. */
  cacheHit?: number;
  /** Tokens the next request starts from: the last step's prompt and answer. */
  context?: number;
  decode: { last?: number; avg?: number; best?: number };
  prefill: { avg?: number };
  ttft: { last?: number; avg?: number };
  /** Summed model time (request to end of stream), ms. */
  modelTime: number;
  tools: ToolCount[];
  toolErrors: number;
  plugins: {
    /** Magic Context's ctx_* tools, by name without the prefix. */
    magicContext: ToolCount[];
    /** Reads and commands secret-guard refused. */
    secretGuardBlocks: number;
    /** task/subagent dispatches to the workers. */
    dispatches: number;
  };
  workers: { total: number; running: number; failed: number };
}

const DISPATCH_TOOLS = new Set(["task", "subagent"]);

export function sessionStats(session: Pick<SessionView, "children">, messages: Message[]): SessionStats {
  const steps = messages.filter((m): m is AssistantMessage => m.kind === "assistant");
  const tokens: StepTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
  for (const m of steps) {
    if (!m.tokens) continue;
    tokens.input += m.tokens.input;
    tokens.output += m.tokens.output;
    tokens.reasoning += m.tokens.reasoning;
    tokens.cacheRead += m.tokens.cacheRead;
  }
  const prompt = tokens.input + tokens.cacheRead;

  const rates = steps.map((m) => ({ m, r: stepRate(m) }));
  const lastDecode = [...rates].reverse().find((x) => x.r.decode !== undefined)?.r.decode;
  const lastTtft = [...rates].reverse().find((x) => x.r.ttft !== undefined)?.r.ttft;
  const ttfts = rates.map((x) => x.r.ttft).filter((v): v is number => v !== undefined);
  let pTok = 0;
  let pMs = 0;
  for (const { m, r } of rates) {
    if (r.prefill === undefined) continue;
    pTok += m.tokens!.input;
    pMs += r.ttft!;
  }
  const lastTok = [...steps].reverse().find((m) => m.tokens)?.tokens;
  const agg = aggregateDecode(steps);

  const byTool = new Map<string, ToolCount>();
  let toolErrors = 0;
  let secretGuardBlocks = 0;
  let dispatches = 0;
  for (const m of steps)
    for (const b of m.blocks) {
      if (b.type !== "tool") continue;
      const c = byTool.get(b.name) ?? { name: b.name, calls: 0, errors: 0 };
      c.calls++;
      if (b.status === "error") {
        c.errors++;
        toolErrors++;
        if (isGuardBlock(b)) secretGuardBlocks++;
      }
      if (DISPATCH_TOOLS.has(b.name)) dispatches++;
      byTool.set(b.name, c);
    }
  const tools = [...byTool.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  return {
    turns: messages.filter((m) => m.kind === "user").length,
    steps: steps.length,
    tokens,
    cacheHit: prompt ? tokens.cacheRead / prompt : undefined,
    context: lastTok ? lastTok.input + lastTok.cacheRead + lastTok.output : undefined,
    decode: { last: lastDecode, avg: agg.rate, best: agg.best },
    prefill: { avg: pMs ? pTok / (pMs / 1000) : undefined },
    ttft: { last: lastTtft, avg: ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : undefined },
    modelTime: steps.reduce((a, m) => a + (m.timing?.end ? m.timing.end - m.timing.start : 0), 0),
    tools,
    toolErrors,
    plugins: {
      magicContext: tools.filter((t) => t.name.startsWith("ctx_")).map((t) => ({ ...t, name: t.name.slice(4) })),
      secretGuardBlocks,
      dispatches,
    },
    workers: {
      total: session.children.length,
      running: session.children.filter((c) => c.status === "busy").length,
      failed: session.children.filter((c) => c.status === "error").length,
    },
  };
}

function isGuardBlock(t: ToolBlock): boolean {
  return Boolean(t.error?.includes("[secret-guard]"));
}
