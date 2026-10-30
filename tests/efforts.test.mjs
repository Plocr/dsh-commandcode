import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BUNDLED_EFFORTS, DEFAULT_EFFORTS_URL, EFFORT_LEVELS, effortMap, fetchEfforts, parseEfforts, resolveEfforts } from '../lib/efforts.js'

/**
 * The reference the official CLI ships, reduced to the two shapes that matter:
 * a stated ladder, and the em dash that means "no effort control at all".
 */
const REFERENCE = `# Command Code Models

| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |
|---|---|---|---|---|---|---|
| \`deepseek/deepseek-v4-pro\` | DeepSeek V4 Pro | 1M | off, high, max | $0.66/$1.98 | Go and above | reasoning |
| \`minimax/minimax-m3.1-flash\` | MiniMax M3.1 Flash | 1M | low, medium, high, xhigh, max | $0.15/$0.6 | Go and above | coding |
| \`moonshotai/Kimi-K2.7-Code\` | Kimi K2.7 Code | 256K | — | $0.95/$4 | Go and above | coding |
`

describe('effort reference', () => {
  it('parses the vendor table into one ladder per model', () => {
    assert.deepEqual(parseEfforts(REFERENCE), {
      'deepseek/deepseek-v4-pro': ['off', 'high', 'max'],
      'minimax/minimax-m3.1-flash': ['low', 'medium', 'high', 'xhigh', 'max'],
      'moonshotai/Kimi-K2.7-Code': [],
    })
  })

  it('normalizes case and repeated supported levels', () => {
    const table = parseEfforts('| `a/b` | n | 1M | LOW, High, high | $1 | Go | b |\n')
    assert.deepEqual(table, { 'a/b': ['low', 'high'] })
  })

  it('ignores anything that is not a model row', () => {
    const table = parseEfforts(`${REFERENCE}\n| not-a-model | x |\n---\n`)
    assert.deepEqual(Object.keys(table), ['deepseek/deepseek-v4-pro', 'minimax/minimax-m3.1-flash', 'moonshotai/Kimi-K2.7-Code'])
  })

  it('turns a ladder into the map llm-pi-ai dispatches on, off included', () => {
    // `off` is a wire value here, not "omit the parameter": omission leaves a
    // thinking-by-default model thinking, which is the bug this replaced.
    assert.deepEqual(effortMap(['off', 'high', 'max']), { off: 'off', high: 'high', max: 'max' })
  })

  it('reads and parses the live reference', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async (url) => {
      assert.match(String(url), /models\.md$/)
      return { ok: true, status: 200, text: async () => REFERENCE }
    }
    try {
      const table = await fetchEfforts(DEFAULT_EFFORTS_URL)
      assert.deepEqual(table['deepseek/deepseek-v4-pro'], ['off', 'high', 'max'])
    } finally {
      globalThis.fetch = original
    }
  })

  it('refuses a response that states no table, so the bundled snapshot wins', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>not the reference</html>' })
    try {
      await assert.rejects(() => fetchEfforts(DEFAULT_EFFORTS_URL), /stated no model table/)
    } finally {
      globalThis.fetch = original
    }
    const failing = globalThis.fetch
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '' })
    try {
      await assert.rejects(() => fetchEfforts(DEFAULT_EFFORTS_URL), /answered 503/)
    } finally {
      globalThis.fetch = failing
    }
  })
})

describe('bundled snapshot', () => {
  it('states the ladders the gateway cannot state itself', () => {
    // DeepSeek V4 Pro answers 200 to `low` and `xhigh` and silently clamps both;
    // its ladder is exactly this.
    assert.deepEqual(BUNDLED_EFFORTS['deepseek/deepseek-v4-pro'], ['off', 'high', 'max'])
    assert.deepEqual(BUNDLED_EFFORTS['deepseek/deepseek-v4.1-flash'], ['off', 'low', 'high', 'max'])
    assert.deepEqual(BUNDLED_EFFORTS['zai-org/GLM-5.2'], ['high', 'max'])
    assert.deepEqual(BUNDLED_EFFORTS['MiniMaxAI/MiniMax-M3'], ['low', 'medium', 'high'])
  })

  it('marks models with no effort control as an empty ladder, not a missing one', () => {
    assert.deepEqual(BUNDLED_EFFORTS['moonshotai/Kimi-K3'], ['low', 'high', 'max'])
    assert.deepEqual(BUNDLED_EFFORTS['zai-org/GLM-5'], [])
    assert.ok('zai-org/GLM-5' in BUNDLED_EFFORTS)
  })

  it('only ever states levels llm-pi-ai can dispatch', () => {
    for (const [id, levels] of Object.entries(BUNDLED_EFFORTS)) {
      assert.ok(Array.isArray(levels), `${id} must carry a ladder`)
      for (const level of levels) assert.ok(EFFORT_LEVELS.includes(level), `${id} names ${level}`)
      assert.equal(new Set(levels).size, levels.length, `${id} repeats a level`)
    }
    assert.ok(Object.keys(BUNDLED_EFFORTS).length >= 90)
  })
})


describe('reference resilience', () => {
  it('locates reordered columns and sorts levels by strength', () => {
    assert.deepEqual(parseEfforts('| Efforts | Id (use EXACTLY this) | Name |\n| max, low, high | `a/b` | B |'), { 'a/b': ['low', 'high', 'max'] })
  })
  it('rejects unknown, empty, off-only and conflicting declarations with diagnostics', () => {
    const diagnostics = []
    const result = parseEfforts('| `a/b` | B | 1M | turbo |\n| `c/d` | D | 1M | |\n| `e/f` | F | 1M | high |\n| `e/f` | F | 1M | low |\n| `g/h` | H | 1M | off |', diagnostics)
    assert.deepEqual(result, {})
    assert.equal(diagnostics.length, 4)
  })
  it('preserves explicit no-control entries while filling missing models from the snapshot', () => {
    const levels = resolveEfforts({ 'deepseek/deepseek-v4-pro': [] })
    assert.deepEqual(levels['deepseek/deepseek-v4-pro'], [])
    assert.deepEqual(levels['zai-org/GLM-5.2'], ['high', 'max'])
  })
})
