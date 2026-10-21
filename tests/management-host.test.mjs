import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { apply, Config } from '../lib/index.js'

const mounted = []
afterEach(async () => {
  for (const host of mounted.splice(0)) host.dispose()
  await new Promise(setImmediate)
})
function mount(extra = {}) {
  const config = { plan: 'goat', autoSync: false, ...extra }
  const providers = {}, effects = [], routes = []
  let revision = 0
  const settings = {
    describe() { return [{ ns: 'commandcode-goat', revision, value: config }, { ns: 'llm-pi-ai', revision, value: { providers } }] },
    async mutate(ns, ops, expected) {
      assert.equal(expected, revision)
      const next = structuredClone(ns === 'llm-pi-ai' ? { providers } : config)
      for (const op of ops) {
        let parent = next
        for (const key of op.path.slice(0, -1)) parent = parent[key] ??= {}
        if (op.op === 'unset') delete parent[op.path.at(-1)]
        else parent[op.path.at(-1)] = structuredClone(op.value)
      }
      if (ns === 'llm-pi-ai') { for (const key of Object.keys(providers)) delete providers[key]; Object.assign(providers, next.providers) }
      else { Config(next); for (const key of Object.keys(config)) delete config[key]; Object.assign(config, next) }
      revision++
    },
  }
  const ctx = { settings, webServer: { register(route) { routes.push(route); return () => {} } },
    credentials: { resolve: async () => ({ value: 'fake-key' }) }, logger: { info() {}, warn() {} },
    fiber: { entry: { options: { id: 'commandcode-goat' } } },
    get(name) { return this[name] }, on() {},
    inject(names, fn) { if (names.every((name) => this[name])) fn(this) },
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
  }
  apply(ctx, config)
  const host = { config, providers, dispose() { for (const fn of [...effects].reverse()) fn?.() },
    async call(path, body = {}) {
      let result
      const route = routes.find((route) => route.path.endsWith(path))
      const request = { method: 'POST', headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
      await route.handler(request, { setHeader() {}, end(value) { result = JSON.parse(value) } })
      return result
    },
  }
  mounted.push(host)
  return host
}
const models = [{ id: 'vendor/a', context_length: 100000, supported_endpoints: ['/chat/completions'] },
  { id: 'vendor/b', context_length: 200000, supported_endpoints: ['/chat/completions'] }]
const entries = models.map((model) => ({ slug: model.id.replace('/', '-'), id: model.id, name: model.id, minPlanName: 'GOAT', vision: true, reasoning: true }))
async function upstream(task, { list = () => models, credits } = {}) {
  const previous = fetch, calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    // The effort reference is the third upstream fact a sync reads; it states a
    // ladder per model, and the gateway cannot answer this itself.
    if (String(url).endsWith('models.md')) return { ok: true, status: 200, text: async () => '| `vendor/a` | A | 1M | off, high, max | $1 | Go | b |\n| `vendor/b` | B | 1M | — | $1 | Go | b |\n' }
    if (String(url).includes('/models')) return { ok: true, json: async () => ({ data: list() }) }
    if (String(url).includes('/docs/')) {
      const escaped = JSON.stringify(entries).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      return { ok: true, text: async () => `<script>self.__next_f.push([1,"${escaped}"])</script>` }
    }
    if (String(url).endsWith('/whoami')) return { ok: true, json: async () => ({ user: { id: 'fake' } }) }
    if (String(url).endsWith('/summary')) return { ok: true, json: async () => ({ totalCount: 100, completedCount: 1, successRate: 1 }) }
    if (String(url).endsWith('/credits')) return { ok: true, json: async () => credits ?? { credits: { monthlyCredits: 20, purchasedCredits: 0, freeCredits: 0 } } }
    if (String(url).endsWith('/subscriptions')) return { ok: true, json: async () => ({ data: { planId: 'individual-goat' } }) }
    return { ok: true, status: 200, text: async () => '{}' }
  }
  try { return await task(calls) } finally { globalThis.fetch = previous }
}

describe('0.8 management host actions', () => {
  it('returns a model preset to upstream defaults without mistaking its own previous output for a manual edit', async () => {
    const host = mount()
    await upstream(async () => {
      await host.call('/sync')
      await host.call('/manage', { action: 'preference', id: 'vendor/a', preference: { reasoningPreset: 'off' } })
      await host.call('/sync')
      assert.equal(host.providers['commandcode-goat-autosync'].models[0].reasoningEfforts, false)
      await host.call('/manage', { action: 'preference', id: 'vendor/a', preference: { reasoningPreset: 'auto' } })
      await host.call('/sync')
      // Back to `auto`: the ladder the reference states for this model, which is
      // what the sync generates when no preference overrides it.
      assert.deepEqual(host.providers['commandcode-goat-autosync'].models[0].reasoningEfforts, { off: 'off', high: 'high', max: 'max' })
      const state = await host.call('/manage', { action: 'state' })
      assert.deepEqual(state.value.notifications.filter((event) => event.type === 'model'), [])
    })
  })

  it('rejects a late account response after the credential reference changes', async () => {
    const host = mount({ targetApiKeyEnv: 'OLD' })
    const before = fetch
    let start, release
    const started = new Promise((resolve) => { start = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    globalThis.fetch = async () => { start(); await gate; return Response.json({ user: { id: 'old' }, totalCount: 1, credits: {}, data: {} }) }
    try {
      const pending = host.call('/usage')
      await started
      host.config.targetApiKeyEnv = 'NEW'
      release()
      assert.equal((await pending).code, 'account-changed')
      assert.equal((await host.call('/describe')).value.subscription, undefined)
    } finally { globalThis.fetch = before }
  })

  it('retains last-known vision and tier filtering when the catalog becomes unavailable', async () => {
    const host = mount()
    await upstream(async () => {
      await host.call('/sync')
      const before = fetch
      globalThis.fetch = (url, init) => String(url).includes('/docs/') ? Promise.reject(new Error('fixture outage')) : before(url, init)
      try {
        const result = await host.call('/sync')
        assert.equal(result.ok, true)
        assert.equal(result.value.catalog.available, false)
        assert.deepEqual(host.providers['commandcode-goat-autosync'].models[0].input, ['text', 'image'])
      } finally { globalThis.fetch = before }
    })
  })

  it('previews without provider writes and rejects a stale confirmation', async () => {
    const host = mount()
    await upstream(async () => {
      const preview = await host.call('/sync', { dryRun: true })
      assert.equal(preview.ok, true)
      assert.deepEqual(host.providers, {})
      assert.equal(preview.value.preview.diff.summary.added, 2)
      await host.call('/manage', { action: 'preference', id: 'vendor/a', preference: { hidden: true } })
      const stale = await host.call('/sync', { previewToken: preview.value.preview.token })
      assert.equal(stale.code, 'preview-stale')
      assert.deepEqual(host.providers, {})
    })
  })
  it('publishes selected favorite models with a preset and never automatically probes them', async () => {
    const host = mount()
    await upstream(async (calls) => {
      await host.call('/manage', { action: 'models' })
      await host.call('/manage', { action: 'preference', id: 'vendor/a', preference: { favorite: true, reasoningPreset: 'deep' } })
      await host.call('/manage', { action: 'options', options: { onlyFavorites: true } })
      const synced = await host.call('/sync')
      assert.equal(synced.ok, true)
      const published = host.providers['commandcode-goat-autosync'].models
      assert.equal(published.length, 1)
      // `deep` is the model's own top rung: its ladder stops at `max`, so a
      // hard-coded "high" would have picked a level the reference never states.
      assert.deepEqual(published[0].reasoningEfforts, { off: 'off', max: 'max' })
      assert.equal(calls.some((call) => /chat\/completions|messages$|responses$/.test(call.url)), false)
      const state = await host.call('/manage', { action: 'state' })
      assert.equal(state.value.models.length, 2)
      assert.equal(state.value.models.find((model) => model.id === 'vendor/a').preference.favorite, true)
    })
  })
  it('exports portable preferences, previews import and keeps connection settings private', async () => {
    const host = mount({ targetApiKeyEnv: 'PRIVATE_REF', targetBaseURL: 'https://private.invalid/v1' })
    const exported = await host.call('/manage', { action: 'export' })
    assert.equal(JSON.stringify(exported).includes('PRIVATE_REF'), false)
    const doc = exported.value.document
    doc.configuration.onlyFavorites = true
    const preview = await host.call('/manage', { action: 'import-preview', document: doc })
    assert.equal(host.config.onlyFavorites, undefined)
    const applied = await host.call('/manage', { action: 'import-apply', document: doc, baseSignature: preview.value.baseSignature })
    assert.equal(applied.ok, true)
    assert.equal(host.config.onlyFavorites, true)
    assert.equal(host.config.targetApiKeyEnv, 'PRIVATE_REF')
    assert.equal(host.config.targetBaseURL, 'https://private.invalid/v1')
  })
  it('records a quota crossing once and supports read/clear actions', async () => {
    const host = mount({ alertThresholds: { enabled: true } })
    await upstream(async () => {
      await host.call('/usage')
      await host.call('/usage')
      let state = await host.call('/manage', { action: 'state' })
      assert.equal(state.value.notifications.filter((event) => event.type === 'quota').length, 1)
      state = await host.call('/manage', { action: 'notifications-read' })
      assert.ok(state.value.notifications.every((event) => event.read))
      state = await host.call('/manage', { action: 'notifications-clear' })
      assert.deepEqual(state.value.notifications, [])
    }, { credits: { credits: { monthlyCredits: 20, purchasedCredits: 0, freeCredits: 0 }, windowLimits: { fiveHour: { used: 90, cap: 100, resetAt: 1800000000000 } } } })
  })
  it('notifies on model additions/removals once across repeated successful syncs', async () => {
    const host = mount()
    let current = models
    await upstream(async () => {
      await host.call('/sync')
      current = [models[0], { ...models[1], id: 'vendor/new' }]
      await host.call('/sync')
      await host.call('/sync')
      const state = await host.call('/manage', { action: 'state' })
      assert.deepEqual(state.value.notifications.filter((event) => event.type === 'model').map((event) => event.change).sort(), ['added', 'removed'])
    }, { list: () => current })
  })
})
