/**
 * Per-model reasoning-effort levels, and where they come from.
 *
 * The gateway is not a source of truth for this. It accepts `low`…`max` on
 * every model (a request it cannot honour is answered 200 and quietly clamped),
 * and answers `off` only for models that can actually stop thinking — so a probe
 * can decide "can this model be turned off", but not "which rungs does it really
 * have". `deepseek/deepseek-v4-pro` and `minimax/minimax-m3.1-flash` both answer
 * 200 to `xhigh`; only one of them means it.
 *
 * The vendor states the ladder instead. The official CLI ships it as the model
 * reference it reads when parsing `model:effort`, and that table is the source
 * used here. `BUNDLED_EFFORTS` is a snapshot of it, kept so a sync still produces
 * correct models when the reference cannot be fetched.
 */

/** The reference the official CLI ships; parsed for the per-model effort ladder. */
export const DEFAULT_EFFORTS_URL =
  'https://unpkg.com/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md'

/** The effort levels `llm-pi-ai` knows, in escalation order. */
export const EFFORT_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]

/**
 * Model id → the levels the vendor says the model accepts, in the reference's
 * own order. An empty array means the model has no effort control at all (the
 * reference prints "—"), which is not the same as "it cannot think": the gateway
 * still runs it at whatever depth it defaults to.
 *
 * Snapshot of 2026-10-21T01:03:37.306Z. Refresh by re-reading `DEFAULT_EFFORTS_URL`.
 */
export const BUNDLED_EFFORTS = {
  "claude-fable-5": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "claude-fable-5-1": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "claude-haiku-4-5-20251001": [],
  "claude-haiku-5-5": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "claude-opus-4-7": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "claude-opus-4-8": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "claude-opus-5": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "claude-opus-5-5": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "claude-sonnet-4-6": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "claude-sonnet-5": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "claude-sonnet-5-5": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "deepseek/deepseek-v4-flash": [
    "off",
    "high",
    "max"
  ],
  "deepseek/deepseek-v4-flash-fast": [
    "low",
    "high",
    "max"
  ],
  "deepseek/deepseek-v4-flash-vision-exp": [
    "off",
    "high",
    "max"
  ],
  "deepseek/deepseek-v4-pro": [
    "off",
    "high",
    "max"
  ],
  "deepseek/deepseek-v4.1-flash": [
    "off",
    "low",
    "high",
    "max"
  ],
  "deepseek/deepseek-v4.1-flash-fast": [
    "off",
    "low",
    "high",
    "max"
  ],
  "google/gemini-3.1-flash-lite": [
    "low",
    "medium",
    "high"
  ],
  "google/gemini-3.5-flash": [
    "low",
    "medium",
    "high"
  ],
  "google/gemini-3.5-flash-lite": [
    "low",
    "medium",
    "high"
  ],
  "google/gemini-3.6-flash": [
    "low",
    "medium",
    "high"
  ],
  "google/gemini-3.7-flash": [
    "low",
    "medium",
    "high"
  ],
  "google/gemini-3.8-flash": [
    "low",
    "medium",
    "high"
  ],
  "google/gemini-4-argon": [
    "low",
    "medium",
    "high"
  ],
  "gpt-5.3-codex": [
    "low",
    "medium",
    "high",
    "xhigh"
  ],
  "gpt-5.4": [
    "low",
    "medium",
    "high",
    "xhigh"
  ],
  "gpt-5.4-mini": [
    "low",
    "medium",
    "high"
  ],
  "gpt-5.5": [
    "low",
    "medium",
    "high",
    "xhigh"
  ],
  "gpt-5.6-luna": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "gpt-5.6-sol": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "gpt-5.6-terra": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "gpt-6-astra": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "gpt-6-luna": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "gpt-6-sol": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "gpt-6.1-sol": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "inclusionai/ling-3.1-flash": [
    "low",
    "medium",
    "high"
  ],
  "meituan/LongCat-2.0": [],
  "meta/muse-spark-1.1": [
    "low",
    "medium",
    "high",
    "xhigh"
  ],
  "meta/muse-spark-1.2": [
    "low",
    "medium",
    "high",
    "xhigh"
  ],
  "meta/muse-spark-1.2-contributor": [
    "low",
    "medium",
    "high",
    "xhigh"
  ],
  "meta/muse-spark-1.3": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "meta/muse-spark-1.3-contributor": [
    "low",
    "medium",
    "high",
    "xhigh"
  ],
  "meta/muse-spark-open": [
    "low",
    "medium",
    "high"
  ],
  "meta/muse-wonder-1.0": [
    "low",
    "medium",
    "high",
    "xhigh"
  ],
  "minimax/minimax-m3.1-flash": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "minimax/minimax-m3.1-flash:free": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "MiniMaxAI/MiniMax-M2.5": [],
  "MiniMaxAI/MiniMax-M2.7": [],
  "MiniMaxAI/MiniMax-M3": [
    "low",
    "medium",
    "high"
  ],
  "mistral/mistral-large-4": [
    "low",
    "medium",
    "high"
  ],
  "moonshotai/Kimi-K2.5": [],
  "moonshotai/Kimi-K2.6": [],
  "moonshotai/Kimi-K2.7-Code": [],
  "moonshotai/Kimi-K2.7-Code-Highspeed": [],
  "moonshotai/Kimi-K3": [
    "low",
    "high",
    "max"
  ],
  "nvidia/nemotron-3-ultra-550b-a55b": [],
  "nvidia/nemotron-3.5-super-vl": [
    "low",
    "medium",
    "high"
  ],
  "ornith/ornith-1.5-122b": [],
  "ornith/ornith-1.5-122b:free": [],
  "poolside/laguna-s-2.1-free": [],
  "Qwen/Qwen3.6-Max-Preview": [],
  "Qwen/Qwen3.6-Plus": [],
  "Qwen/Qwen3.7-Flash": [],
  "Qwen/Qwen3.7-Max": [],
  "Qwen/Qwen3.7-Plus": [],
  "Qwen/Qwen3.8-27B": [
    "low",
    "medium",
    "xhigh"
  ],
  "Qwen/Qwen3.8-Flash": [
    "low",
    "medium",
    "xhigh"
  ],
  "Qwen/Qwen3.8-Max": [
    "low",
    "medium",
    "xhigh"
  ],
  "Qwen/Qwen3.8-Max-0902": [
    "low",
    "medium",
    "xhigh"
  ],
  "Qwen/Qwen3.8-Max-Prime": [
    "low",
    "medium",
    "xhigh"
  ],
  "Qwen/Qwen3.8-Omni-Flash": [
    "low",
    "medium",
    "xhigh"
  ],
  "reflection/beam:free": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ],
  "sakana/fugu-ultra": [
    "high",
    "xhigh"
  ],
  "stealth/glyph-cluster:free": [
    "low",
    "medium",
    "high",
    "xhigh"
  ],
  "stepfun/Step-3.5-Flash": [],
  "stepfun/Step-3.7-Flash": [],
  "stepfun/Step-5-Preview": [
    "low",
    "medium",
    "high"
  ],
  "tencent/hy3-paid": [],
  "tencent/hy4-preview": [
    "low",
    "medium",
    "high"
  ],
  "thinkingmachines/inkling": [],
  "thinkingmachines/inkling-small": [],
  "xai/grok-4.5": [
    "low",
    "medium",
    "high"
  ],
  "xai/grok-4.6": [
    "low",
    "medium",
    "high",
    "xhigh"
  ],
  "xai/grok-4.7": [
    "low",
    "medium",
    "high",
    "xhigh"
  ],
  "xiaomi/mimo-v2.5": [],
  "xiaomi/mimo-v2.5-pro": [],
  "xiaomi/mimo-v2.6-flash": [],
  "xiaomi/mimo-v2.6-pro": [],
  "xiaomi/mimo-v2.6-pro-ultraspeed": [],
  "z-ai/glm-5.3-flash": [
    "low",
    "high",
    "max"
  ],
  "z-ai/glm-5.3-flashx": [
    "low",
    "high",
    "max"
  ],
  "zai-org/GLM-5": [],
  "zai-org/GLM-5.1": [],
  "zai-org/GLM-5.2": [
    "high",
    "max"
  ],
  "zai-org/GLM-5.2-Fast": [],
  "zai-org/GLM-5.3": [
    "low",
    "high",
    "max"
  ]
}

/**
 * Parse the reference's markdown tables into `{ id: levels }`.
 *
 * Rows are `| \`id\` | name | context | efforts | cost | plan | blurb |`; only the
 * id and the efforts column are read, and anything outside `EFFORT_LEVELS` is
 * dropped rather than passed through to a request the gateway would reject.
 * @param markdown - the reference document.
 * @returns model id → effort levels, in the order the vendor printed them.
 */
export function parseEfforts(markdown) {
  const table = {}
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const match = /^\|\s*`([^`]+)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(line)
    if (match === null) continue
    const levels = match[4]
      .split(',')
      .map((level) => level.trim().toLowerCase())
      .filter((level) => EFFORT_LEVELS.includes(level))
    table[match[1].trim()] = [...new Set(levels)]
  }
  return table
}

/** Fetch and parse the reference. Throws on anything that is not a usable table. */
export async function fetchEfforts(url, signal) {
  const response = await fetch(url, {
    headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const table = parseEfforts(await response.text())
  if (Object.keys(table).length === 0) throw new Error(`${url} stated no model table`)
  return table
}

/**
 * The `reasoningEfforts` map for one model: every declared level sent as its own
 * wiring value, `off` included. `off` is a real wire value here — where a model
 * accepts it, sending it stops the thinking; leaving the key out would mean
 * "send no parameter", which on a model that thinks by default does nothing.
 */
export function effortMap(levels) {
  return Object.fromEntries(levels.map((level) => [level, level]))
}
