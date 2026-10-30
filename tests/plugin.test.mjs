import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { enableTimeouts } from './timers.mjs'

import {
  Config,
  DEFAULT_AUTO_SYNC_INTERVAL_MS,
  FIRST_SYNC_DELAY_MS,
  MAX_TIMER_DELAY_MS,
  SETTINGS_NS,
  SYNC_TIMEOUT_MS,
  apply,
  normalizeConfig,
  readCatalog,
  syncConfigSignature,
} from '../lib/index.js'
import { DEFAULT_CATALOG_URL } from '../lib/catalog.js'
import { profileState } from '../lib/profile-state.js'

const LLM_PI_AI = 'llm-pi-ai'
const BRIDGE_PREFIX = '/api/dsh-commandcode-goat'

/**
 * A cordis context stand-in, faithful about the four calls this plugin makes:
 * `inject` (only when every named service is present), `get`, `effect`, and
 * service properties on the context itself.
 */
function mockContext(services = {}) {
  const effects = []
  const listeners = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    // The profile row this plugin was composed under: since dsh 0.1.7 that id
    // is also this plugin's settings namespace.
    fiber: { entry: { options: { id: 'commandcode-goat' } } },
    ...services,
    get(name) {
      return this[name]
    },
    inject(names, callback) {
      if (!names.every((name) => this[name] !== undefined)) return
      callback(this)
    },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      mountedEffects.push(dispose)
      return () => dispose?.()
    },
    on(event, handler) {
      listeners.set(event, [...listeners.get(event) ?? [], handler])
    },
    /** Fire an event the way the loader does when a volatile field changes. */
    emit(event) {
      for (const handler of listeners.get(event) ?? []) handler()
    },
    /**
     * Replay one middleware event (`agent/request-error` and friends): a handler
     * that returns a value ends the chain, `next()` continues it. That is the
     * contract the harness uses to decide whether to retry a failed request.
     */
    waterfall(event, payload, final) {
      const chain = listeners.get(event) ?? []
      let index = -1
      const next = async () => {
        index += 1
        if (index >= chain.length) return final
        return await chain[index](payload, next)
      }
      return next()
    },
  }
  return { ctx, effects, listeners }
}

/**
 * The dsh 0.1.7 settings service: `describe()` returns one descriptor per
 * composed entry, keyed by the entry's row id, and `mutate()` writes that
 * entry's own config. There is no namespace registration to record any more.
 */
function mockSettings({ writable = true, entries } = {}) {
  const state = { mutations: [] }
  const settings = {
    writable,
    state,
    describe: () => entries ?? [
      { ns: LLM_PI_AI, revision: 1, value: { providers: {} }, schema: { type: 'object', dict: { providers: {} } } },
      { ns: 'commandcode-goat', revision: 1, value: {} },
    ],
    async mutate(ns, ops, revision) {
      state.mutations.push({ ns, ops, revision })
      return {}
    },
  }
  return settings
}

/** A webServer recording routes and answering their removal. */
function mockWebServer() {
  const state = { routes: [], removed: [] }
  return {
    state,
    register(route) {
      state.routes.push(route)
      return () => state.removed.push(route.path)
    },
  }
}

/** The web seam, recording the provider it was handed. */
function mockWeb({ selected } = {}) {
  const state = { providers: [], disposed: 0 }
  const web = {
    state,
    registerSearchProvider(provider) {
      state.providers.push(provider)
      return () => { state.disposed += 1 }
    },
  }
  if (selected !== undefined) web.searchProviderId = selected
  return web
}

/** The tool registry, recording definitions and honouring the disposer. */
function mockTools() {
  const state = { tools: [], disposals: 0 }
  return {
    state,
    register: (definition) => {
      state.tools.push(definition)
      // `tools.register` returns "the exact disposer that unregisters the tool";
      // the stub returns one too, or nothing could ever be released.
      return () => {
        state.disposals += 1
        const index = state.tools.indexOf(definition)
        if (index >= 0) state.tools.splice(index, 1)
      }
    },
  }
}

/** Run `body` with a stubbed `fetch`, restoring it afterwards. */
async function withFetch(handler, body) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await body()
  } finally {
    globalThis.fetch = original
  }
}

/** Let every promise already queued by a timer callback run to completion. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

/**
 * Every effect the mocked contexts mounted, so the file can unmount them.
 *
 * This is not tidiness. `apply` now always arms the auto-sync timer — the
 * routes have to be created without anyone pressing a button — and a mounted
 * fiber is what owns that timer. Nothing in these tests unmounts a real
 * profile, so without this the process would sit on a pending 15-second
 * timeout after the last assertion and the runner would never exit.
 */
const mountedEffects = []

describe('generated providers on plugin disposal', () => {
  it('releases the loader before removing persisted routes', async () => {
    const key = 'commandcode-goat-autosync'
    const settings = mockSettings({ entries: [{ ns: LLM_PI_AI, revision: 1,
      value: { providers: { [key]: { apiKeyEnv: 'COMMANDCODE_API_KEY' }, custom: {} } } }] })
    const { ctx, effects } = mockContext({ settings })
    const folder = await mkdtemp(join(tmpdir(), 'goat-dispose-'))
    settings.documentPath = join(folder, 'profile.yaml')
    let removed
    const finished = new Promise((resolve) => { removed = resolve })
    const mutate = settings.mutate.bind(settings)
    settings.mutate = async (...args) => { const result = await mutate(...args); removed(); return result }
    apply(ctx, Config({ autoSync: false }))
    const dispose = effects.find((effect) => effect.label === 'dsh-commandcode-goat: generated providers').dispose
    // The disposer must not return a settings write promise: the real host
    // invokes it while holding the same lock settings.mutate needs.
    assert.equal(dispose(), undefined)
    assert.equal(settings.state.mutations.length, 0)
    await finished
    assert.deepEqual(settings.state.mutations[0].ops, [{ op: 'unset', path: ['providers', key] }])
    await rm(folder, { recursive: true, force: true })
  })

  it('cleans up after a settings write that finishes during disposal', async () => {
    const providers = {}
    const settings = mockSettings({ entries: [{ ns: LLM_PI_AI, revision: 1, value: { providers } }] })
    const folder = await mkdtemp(join(tmpdir(), 'goat-dispose-flight-'))
    settings.documentPath = join(folder, 'profile.yaml')
    let cleaned
    const cleanup = new Promise((resolve) => { cleaned = resolve })
    let release
    let started
    const written = new Promise((resolve) => { started = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    const mutate = settings.mutate.bind(settings)
    settings.mutate = async (ns, ops, revision) => {
      if (ops.some((op) => op.op === 'set')) { started(); await gate }
      for (const op of ops) {
        if (op.op === 'unset') delete providers[op.path[1]]
        else providers[op.path[1]] = op.value
      }
      if (ops.some((op) => op.op === 'unset')) cleaned()
      return mutate(ns, ops, revision)
    }
    const webServer = mockWebServer()
    const { ctx, effects } = mockContext({ settings, webServer })
    apply(ctx, Config({ plan: 'goat', autoSync: false }))
    await withFetch(upstreamFetch(), async () => {
      const sync = webServer.state.routes.find((route) => route.path.endsWith('/sync'))
        .handler(bridgeRequest(), bridgeResponse())
      await written
      for (const effect of [...effects].reverse()) effect.dispose?.()
      release()
      await sync
      await cleanup
    })
    assert.deepEqual(providers, {})
    assert.ok(settings.state.mutations.some((write) => write.ops.some((op) => op.op === 'unset')))
    await rm(folder, { recursive: true, force: true })
  })
})

after(() => {
  for (const dispose of mountedEffects.splice(0)) {
    try {
      dispose?.()
    } catch { /* an effect that already tore itself down is not a failure */ }
  }
})

/** A plan page carrying one catalog array, in the shape the page serves. */
function goatPage(entries) {
  const json = JSON.stringify(entries).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `<script>self.__next_f.push([1,"${json}"])</script>`
}

const API_BODY = {
  data: [
    { id: 'vendor/model-one', name: 'Model One', context_length: 200000, supported_endpoints: ['/chat/completions'] },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 1000000, supported_endpoints: ['/messages'] },
  ],
}
const CATALOG_ENTRIES = [
  { slug: 'model-one', id: 'vendor/model-one', name: 'Model One', vendor: 'Vendor', contextWindow: 200000, reasoning: true, vision: true, minPlanName: 'Go' },
  { slug: 'claude-sonnet-5', id: 'claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'Anthropic', contextWindow: 1000000, reasoning: true, vision: true, minPlanName: 'Pro' },
]
/**
 * The effort reference, reduced to the rows these fixtures name. Its ladders are
 * deliberately uneven: `vendor/model-one` stops at `max`, and the Anthropic
 * model's starts at `low`.
 */
const EFFORT_REFERENCE = `| \`vendor/model-one\` | Model One | 200K | off, high, max | $1 | Go | b |
| \`claude-sonnet-5\` | Claude Sonnet 5 | 1M | low, medium, high, xhigh, max | $1 | Pro | b |
`

/** Answer the two upstream sources, and nothing else. */
function upstreamFetch() {
  return async (url) => {
    if (String(url).includes('/provider/v1/models')) {
      return { ok: true, status: 200, json: async () => API_BODY }
    }
    return { ok: true, status: 200, text: async () => goatPage(CATALOG_ENTRIES) }
  }
}

describe('Config', () => {
  it('resolves the documented defaults', () => {
    // Read through `normalizeConfig`, because a volatile field resolves to a
    // live reference rather than to its value.
    const resolved = normalizeConfig(Config({}))
    assert.equal(resolved.plan, 'goat')
    assert.equal(resolved.sourceURL, 'https://api.commandcode.ai/provider/v1/models')
    assert.equal(resolved.catalogURL, 'https://commandcode.ai/docs/plans/goat')
    assert.equal(resolved.usageBaseURL, 'https://api.commandcode.ai')
    assert.equal(resolved.autoSync, true)
    assert.equal(resolved.webSearch, false)
    assert.equal(resolved.includeReasoningEfforts, false)
    assert.equal(resolved.enableUsageTool, true)
    assert.equal(resolved.enableBridge, true)
    assert.deepEqual(resolved.extraIds, [])
    assert.equal(resolved.autoSyncIntervalMs, 6 * 60 * 60 * 1000)
  })

  it('rejects a tier that is not offered', () => {
    assert.equal(normalizeConfig(Config({ plan: 'pro' })).plan, 'pro')
    assert.throws(() => Config({ plan: 'ultra' }))
  })

  it('satisfies the Standard Schema interface Cordis validates against', () => {
    assert.equal(typeof Config['~standard']?.validate, 'function')
  })
})

describe('normalizeConfig', () => {
  it('reads an empty string as "use the default", which the schema cannot express', () => {
    const resolved = normalizeConfig({ targetApiKeyEnv: '   ', targetBaseURL: '', sourceURL: '' })
    assert.equal(resolved.targetApiKeyEnv, 'COMMANDCODE_API_KEY')
    assert.equal(resolved.targetBaseURL, 'https://api.commandcode.ai/provider/v1')
    assert.equal(resolved.sourceURL, 'https://api.commandcode.ai/provider/v1/models')
  })

  it('clamps the auto-sync cadence and drops blank extra ids', () => {
    assert.equal(normalizeConfig({ autoSyncIntervalMs: 10 }).autoSyncIntervalMs, 6 * 60 * 60 * 1000)
    assert.equal(normalizeConfig({ autoSyncIntervalMs: 120_000 }).autoSyncIntervalMs, 120_000)
    assert.deepEqual(normalizeConfig({ extraIds: ['a', '  ', 7] }).extraIds, ['a'])
  })

  it('carries a context-window cap through, and treats anything unusable as "no cap"', () => {
    // 0 is the default and means "publish the vendor's number", so a bad value
    // must not turn into a cap of some small number — that would compact every
    // conversation down to nothing.
    assert.equal(normalizeConfig({}).maxContextWindow, 0)
    assert.equal(normalizeConfig({ maxContextWindow: 128_000 }).maxContextWindow, 128_000)
    assert.equal(normalizeConfig({ maxContextWindow: -1 }).maxContextWindow, 0)
    assert.equal(normalizeConfig({ maxContextWindow: 'lots' }).maxContextWindow, 0)
  })

  it('reads the guard ratio as a share of the route\'s window, 0 meaning "off"', () => {
    // 0 means "no guard", so an unusable value must not silently become a tiny
    // budget that prunes every session from the first step.
    assert.equal(normalizeConfig({}).contextGuardRatio, 0.7)
    assert.equal(normalizeConfig({ contextGuardRatio: 0 }).contextGuardRatio, 0)
    assert.equal(normalizeConfig({ contextGuardRatio: 0.5 }).contextGuardRatio, 0.5)
    assert.equal(normalizeConfig({ contextGuardRatio: -1 }).contextGuardRatio, 0.7)
    assert.equal(normalizeConfig({ contextGuardRatio: 'half' }).contextGuardRatio, 0.7)
  })

  it('signs a sync with the fields a sync reads, and nothing else', () => {
    const base = normalizeConfig({ plan: 'goat' })
    // A field the run reads changes the signature...
    for (const [key, value] of Object.entries({
      plan: 'max',
      sourceURL: 'https://elsewhere.test/models',
      catalogURL: 'https://elsewhere.test/plans/goat',
      extraIds: ['private/model'],
      effortSourceURL: 'https://elsewhere.test/models.md',
      maxContextWindow: 800_000,
      targetApiKeyEnv: 'ANOTHER_KEY',
      targetBaseURL: 'https://gateway.test/v1',
      pruneOtherPlans: false,
    })) {
      assert.notEqual(syncConfigSignature(base), syncConfigSignature({ ...base, [key]: value }), `${key} must invalidate a running sync`)
    }
    // ...and one it does not leaves it alone, however the reader flips it.
    assert.equal(syncConfigSignature(base), syncConfigSignature({
      ...base,
      webSearch: !base.webSearch,
      enableUsageTool: false,
      contextGuardRatio: 0.5,
      recoverUpstreamOverflow: false,
      autoSync: false,
      autoSyncIntervalMs: 60_000,
      usageBaseURL: 'https://elsewhere.test',
      enableBridge: false,
    }))
  })

  it('reads auto-sync as on unless it was explicitly turned off', () => {
    // The whole point of the default is that a fresh install produces the
    // provider row in Settings → Models without anyone finding a button, so
    // only an explicit `false` may disable it. An absent field — a config
    // written before this default existed, or a profile patch that omits it —
    // has to keep meaning "on".
    assert.equal(normalizeConfig({}).autoSync, true)
    assert.equal(normalizeConfig({ autoSync: undefined }).autoSync, true)
    assert.equal(normalizeConfig({ autoSync: true }).autoSync, true)
    assert.equal(normalizeConfig({ autoSync: false }).autoSync, false)
  })

  it('falls back to goat for an unknown tier', () => {
    assert.equal(normalizeConfig({ plan: 'ultra' }).plan, 'goat')
  })
})

describe('apply', () => {
  it('loads in a profile with no services at all', () => {
    const { ctx } = mockContext()
    assert.doesNotThrow(() => apply(ctx, Config({})))
  })

  it('marks every field volatile, which is what makes it configurable', () => {
    // dsh 0.1.7 projects a form — and accepts a write — only for fields carrying
    // this marker, so an unmarked field is silently unconfigurable.
    for (const [key, field] of Object.entries(Config.dict)) {
      assert.equal(field.meta?.volatile, true, `${key} is not volatile`)
    }
  })

  it('reports the entry id its form binds to', async () => {
    const settings = mockSettings()
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings, webServer })
    apply(ctx, Config({}))
    const route = webServer.state.routes.find((entry) => entry.path.endsWith('/describe'))
    const res = bridgeResponse()
    // Offline: a status read reaches for the catalog when it has none, and this
    // suite is required to pass with no network at all.
    await withFetch(async () => { throw new TypeError('offline') }, () => route.handler(bridgeRequest(), res))
    assert.equal(JSON.parse(res.body).value.entryId, 'commandcode-goat')
  })

  it('falls back to the row id its own patch declares, not the package name', async () => {
    // A context with no fiber — a programmatic mount — still has to name the
    // row the bundle's patch inserts, because that is what the settings
    // service keys a form by. The package name is a different string and
    // nothing serves a section under it.
    const settings = mockSettings()
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings, webServer })
    delete ctx.fiber
    apply(ctx, Config({}))
    const route = webServer.state.routes.find((entry) => entry.path.endsWith('/describe'))
    const res = bridgeResponse()
    await withFetch(async () => { throw new TypeError('offline') }, () => route.handler(bridgeRequest(), res))
    assert.equal(JSON.parse(res.body).value.entryId, SETTINGS_NS)
    assert.equal(SETTINGS_NS, 'commandcode-goat')
  })

  it('registers the bridge and the search provider, and takes the search selection', () => {
    const settings = mockSettings()
    const webServer = mockWebServer()
    const web = mockWeb()
    const { ctx } = mockContext({ settings, webServer, web })
    apply(ctx, Config({ webSearch: true }))

    assert.deepEqual(webServer.state.routes.map((route) => route.path), [
      `${BRIDGE_PREFIX}/describe`,
      `${BRIDGE_PREFIX}/sync`,
      `${BRIDGE_PREFIX}/prune`,
      `${BRIDGE_PREFIX}/usage`,
      `${BRIDGE_PREFIX}/manage`,
    ])
    assert.equal(web.state.providers.length, 1)
    assert.equal(web.state.providers[0].id, 'commandcode')
    assert.equal(web.searchProviderId, 'commandcode')
  })

  it('leaves the search selection alone until the toggle is on', () => {
    const web = mockWeb()
    const { ctx } = mockContext({ settings: mockSettings(), web })
    apply(ctx, Config({ webSearch: false }))
    assert.equal('searchProviderId' in web, false)
    assert.equal(web.state.providers[0].available(), false)
  })

  it('takes the search seat when the toggle is on, even over a named provider', () => {
    const web = mockWeb({ selected: 'deepseek-official' })
    const { ctx, effects } = mockContext({ settings: mockSettings(), web })
    apply(ctx, Config({ webSearch: true }))
    assert.equal(web.searchProviderId, 'commandcode')
    for (const effect of [...effects].reverse()) effect.dispose?.()
    assert.equal(web.searchProviderId, 'deepseek-official', 'and hands it back on unload')
  })

  it('releases the web provider and the selection when the fiber unloads', () => {
    const web = mockWeb()
    const webServer = mockWebServer()
    const { ctx, effects } = mockContext({ settings: mockSettings(), web, webServer })
    apply(ctx, Config({ webSearch: true }))
    assert.equal(web.searchProviderId, 'commandcode')
    for (const effect of [...effects].reverse()) effect.dispose?.()
    assert.equal(web.state.disposed, 1)
    assert.equal('searchProviderId' in web, false)
    assert.deepEqual(webServer.state.removed, [
      `${BRIDGE_PREFIX}/describe`,
      `${BRIDGE_PREFIX}/sync`,
      `${BRIDGE_PREFIX}/prune`,
      `${BRIDGE_PREFIX}/usage`,
      `${BRIDGE_PREFIX}/manage`,
    ])
  })

  it('does not register a bridge the deployment turned off', () => {
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings: mockSettings(), webServer })
    apply(ctx, Config({ enableBridge: false }))
    assert.equal(webServer.state.routes.length, 0)
  })

  it('registers the usage tool with an output the registry accepts', () => {
    const tools = mockTools()
    const { ctx } = mockContext({ settings: mockSettings(), tools })
    apply(ctx, Config({}))
    assert.equal(tools.state.tools.length, 1)
    const tool = tools.state.tools[0]
    assert.equal(tool.name, 'commandcode_usage')
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.deepEqual(tool.output.render({}, 'hello'), [{ type: 'text', text: 'hello' }])
    assert.equal(tool.parameters.type, 'object')
  })

  it('omits the usage tool when the deployment turned it off', () => {
    const tools = mockTools()
    const { ctx } = mockContext({ settings: mockSettings(), tools })
    apply(ctx, Config({ enableUsageTool: false }))
    assert.equal(tools.state.tools.length, 0)
  })

  it('registers and releases the usage tool as its switch moves', () => {
    // The switch is a volatile field: the card writes it without remounting the
    // plugin. A registration decided once at mount kept offering the tool after
    // the reader switched it off — the switch said one thing and the model's
    // tool list another, and the account kept paying for calls the user had
    // declined. Only a restart used to reconcile the two.
    const tools = mockTools()
    const { ctx, effects } = mockContext({ settings: mockSettings(), tools })
    // Volatile fields arrive as live references, so mutating this object is
    // exactly what a settings write does to a running instance.
    const config = Config({ enableUsageTool: true })
    apply(ctx, config)
    assert.equal(tools.state.tools.length, 1)

    config.enableUsageTool = false
    ctx.emit('loader/volatile-update')
    assert.equal(tools.state.tools.length, 0, 'off means off, without a restart')
    assert.equal(tools.state.disposals, 1)

    // A repeat of the same value must not register a second copy, and must not
    // release anything: the registry refuses duplicate names.
    ctx.emit('loader/volatile-update')
    assert.equal(tools.state.disposals, 1)

    config.enableUsageTool = true
    ctx.emit('loader/volatile-update')
    assert.equal(tools.state.tools.length, 1, 'and back on again')

    for (const effect of [...effects].reverse()) effect.dispose?.()
    assert.equal(tools.state.tools.length, 0, 'unload releases the registration')
    ctx.emit('loader/volatile-update')
    assert.equal(tools.state.tools.length, 0, 'a later config event cannot resurrect the unloaded tool')
  })

  it('does not select an unloaded search service after a volatile update', () => {
    const web = mockWeb({ selected: 'original' })
    const { ctx, effects } = mockContext({ web })
    const config = Config({ webSearch: true })
    apply(ctx, config)
    assert.equal(web.searchProviderId, 'commandcode')
    const cleanup = effects.find((effect) => effect.label === 'dsh-commandcode-goat: web search')
    cleanup.dispose()
    assert.equal(web.searchProviderId, 'original')
    ctx.emit('loader/volatile-update')
    assert.equal(web.searchProviderId, 'original')
  })
})

/**
 * The routes have to exist before anyone can type a key into them.
 *
 * A plugin whose whole job is to make a subscription selectable, but which
 * waits for someone to find a button, reads as broken rather than as pending:
 * no provider row appears in Settings → Models, so there is nowhere to put the
 * credential and no reason to believe the install did anything.
 */
describe('automatic creation', () => {
  /** Mount the plugin with a mutable config, and a fetch that answers upstream. */
  function mount(config = {}) {
    const settings = mockSettings()
    const { ctx } = mockContext({ settings })
    apply(ctx, config)
    return { settings, config }
  }

  it('splits long intervals without syncing early or overflowing the timer', async (t) => {
    const timers = enableTimeouts(t)
    const { settings } = mount(Config({ autoSyncIntervalMs: MAX_TIMER_DELAY_MS + 60_000 }))
    await withFetch(upstreamFetch(), async () => {
      timers.tick(FIRST_SYNC_DELAY_MS)
      await settle()
      assert.equal(settings.state.mutations.length, 1)
      timers.tick(MAX_TIMER_DELAY_MS)
      await settle()
      assert.equal(settings.state.mutations.length, 1)
      timers.tick(59_999)
      await settle()
      assert.equal(settings.state.mutations.length, 1)
      timers.tick(1)
      await settle()
      assert.equal(settings.state.mutations.length, 2)
    })
  })

  it('creates the routes on its own, after letting the tree compose', async (t) => {
    const timers = enableTimeouts(t)
    const { settings } = mount(Config({}))
    // Nothing is written while the tree is still coming up: the write targets
    // another plugin's section and would race that plugin's registration.
    assert.equal(settings.state.mutations.length, 0)

    await withFetch(upstreamFetch(), async () => {
      timers.tick(FIRST_SYNC_DELAY_MS)
      await settle()
    })
    assert.equal(settings.state.mutations.length, 1)
    assert.equal(settings.state.mutations[0].ns, LLM_PI_AI)
  })

  it('reads the toggle at each tick, so turning it off stops the writes', async (t) => {
    const timers = enableTimeouts(t)
    // A plain object, not `Config({...})`: this is the live reference the card
    // edits in place, which is the whole point of a volatile field.
    const { settings, config } = mount({ autoSync: false })
    await withFetch(upstreamFetch(), async () => {
      timers.tick(FIRST_SYNC_DELAY_MS)
      await settle()
    })
    assert.equal(settings.state.mutations.length, 0, 'an off switch means no write')

    // Flipped the way the card flips it — no remount, no reload.
    config.autoSync = true
    await withFetch(upstreamFetch(), async () => {
      timers.tick(DEFAULT_AUTO_SYNC_INTERVAL_MS)
      await settle()
    })
    assert.equal(settings.state.mutations.length, 1, 'the flip reaches the next tick')
  })

  it('never sweeps another tier’s routes from the timer', async (t) => {
    // Removing a configuration is the button's job. Doing it from a background
    // tick would delete the other tier behind a reader who is mid-switch, and a
    // profile composing two rows for two plans would have each row delete the
    // other's routes the moment it started.
    const timers = enableTimeouts(t)
    const settings = mockSettings({
      entries: [{
        ns: LLM_PI_AI,
        revision: 1,
        value: { providers: { 'commandcode-pro-autosync': { models: [{ id: 'mine' }] } } },
        schema: { type: 'object', dict: { providers: {} } },
      }],
    })
    const { ctx } = mockContext({ settings })
    apply(ctx, Config({ plan: 'goat' }))
    await withFetch(upstreamFetch(), async () => {
      timers.tick(FIRST_SYNC_DELAY_MS)
      await settle()
    })
    assert.ok(settings.state.mutations.length > 0, 'the tier was written')
    assert.ok(
      settings.state.mutations.every((mutation) => mutation.ops.every((op) => op.op === 'set')),
      'and nothing was deleted',
    )
  })

  it('reschedules from the interval as it stands after the tick', async (t) => {
    const timers = enableTimeouts(t)
    const { settings, config } = mount({ autoSync: true, autoSyncIntervalMs: 60_000 })
    await withFetch(upstreamFetch(), async () => {
      timers.tick(FIRST_SYNC_DELAY_MS)
      await settle()
    })
    assert.equal(settings.state.mutations.length, 1)

    // The wait already scheduled uses the cadence that was in force when it was
    // scheduled — a pending timer is not retroactively shortened. Changing the
    // interval therefore governs the wait scheduled *next*, so the new value is
    // in force from the cycle after that one.
    config.autoSyncIntervalMs = 24 * 60 * 60 * 1000
    await withFetch(upstreamFetch(), async () => {
      timers.tick(60_000)
      await settle()
    })
    assert.equal(settings.state.mutations.length, 2, 'the wait already scheduled still ran')

    await withFetch(upstreamFetch(), async () => {
      timers.tick(60_000)
      await settle()
    })
    assert.equal(settings.state.mutations.length, 2, 'and the new cadence stopped the next one')

    await withFetch(upstreamFetch(), async () => {
      timers.tick(24 * 60 * 60 * 1000)
      await settle()
    })
    assert.equal(settings.state.mutations.length, 3, 'the new cadence is now what waits')
  })
})

/** A request good enough for the bridge guard. */
function bridgeRequest(body = '{}') {
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  }
}

/** A response that records what was written. */
function bridgeResponse() {
  return {
    statusCode: undefined,
    setHeader() {},
    end(text) {
      this.body = text
    },
  }
}

describe('the sync the bridge drives', () => {
  /** Mount the plugin and hand back one bridge route. */
  function mount(config = {}) {
    const settings = mockSettings()
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings, webServer })
    apply(ctx, Config(config))
    return {
      settings,
      route: (suffix) => webServer.state.routes.find((entry) => entry.path === `${BRIDGE_PREFIX}${suffix}`),
    }
  }

  /** Drive one route and return the parsed answer. */
  async function drive(route, body) {
    const res = bridgeResponse()
    await route.handler(bridgeRequest(body), res)
    return JSON.parse(res.body)
  }

  it('clears a previous subscription when the next account read fails', async () => {
    const { route } = mount({ targetApiKeyEnv: 'CC_USAGE_CACHE_TEST' })
    const previous = process.env.CC_USAGE_CACHE_TEST
    process.env.CC_USAGE_CACHE_TEST = 'fake-key'
    let healthy = true
    try {
      await withFetch(async (url) => {
        if (String(url).includes('/docs/plans/')) return { ok: true, text: async () => goatPage(CATALOG_ENTRIES) }
        if (!healthy) return { ok: false, status: 401 }
        return { ok: true, json: async () => ({ data: { planId: 'individual-pro', status: 'active' } }) }
      }, async () => {
        await drive(route('/usage'))
        assert.equal((await drive(route('/describe'))).value.subscription.plan, 'pro')
        healthy = false
        await drive(route('/usage'))
        assert.equal((await drive(route('/describe'))).value.subscription, undefined)
      })
    } finally {
      if (previous === undefined) delete process.env.CC_USAGE_CACHE_TEST
      else process.env.CC_USAGE_CACHE_TEST = previous
    }
  })

  it('rejects overlapping sync and prune calls and releases the lock after failure', async () => {
    const { settings, route } = mount()
    let release
    let notify
    const started = new Promise((resolve) => { notify = resolve })
    await withFetch(async () => {
      notify()
      await new Promise((resolve) => { release = resolve })
      throw new Error('discovery failed')
    }, async () => {
      const first = drive(route('/sync'))
      await started
      assert.equal((await drive(route('/sync'))).code, 'sync-busy')
      assert.equal((await drive(route('/prune'))).code, 'sync-busy')
      assert.equal(settings.state.mutations.length, 0)
      release()
      assert.equal((await first).ok, false)
      assert.equal((await drive(route('/prune'))).ok, true)
    })
  })

  it('does not write a stale plan when config changes during discovery', async () => {
    const settings = mockSettings()
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings, webServer })
    const config = Config({ plan: 'pro' })
    apply(ctx, config)
    const upstream = upstreamFetch()
    const payload = await withFetch(async (...args) => {
      config.plan = 'goat'
      return upstream(...args)
    }, () => drive(webServer.state.routes.find((route) => route.path.endsWith('/sync'))))
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'config-changed')
    assert.equal(settings.state.mutations.length, 0)
  })

  it('still syncs when a field the run does not read changes during discovery', async () => {
    // Discovery takes seconds. A reader who flips the search switch, the usage
    // tool or the guard ratio in that window has not changed what this run
    // publishes, so the run must land rather than refuse with config-changed.
    const settings = mockSettings()
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings, webServer })
    const config = Config({ plan: 'pro' })
    apply(ctx, config)
    const upstream = upstreamFetch()
    const payload = await withFetch(async (...args) => {
      config.webSearch = !config.webSearch
      config.enableUsageTool = false
      config.contextGuardRatio = 0.5
      return upstream(...args)
    }, () => drive(webServer.state.routes.find((route) => route.path.endsWith('/sync'))))
    assert.equal(payload.ok, true)
    assert.ok(settings.state.mutations.length > 0, 'the tier was written')
  })

  it('aborts discovery on unload and prevents a late write', async () => {
    const settings = mockSettings()
    const webServer = mockWebServer()
    const { ctx, effects } = mockContext({ settings, webServer })
    apply(ctx, Config({ plan: 'pro' }))
    let signal
    const upstream = upstreamFetch()
    const payload = await withFetch(async (url, options) => {
      signal = options.signal
      for (const effect of [...effects].reverse()) effect.dispose?.()
      return upstream(url, options)
    }, () => drive(webServer.state.routes.find((route) => route.path.endsWith('/sync'))))
    assert.equal(signal.aborted, true)
    assert.equal(payload.ok, false)
    assert.equal(settings.state.mutations.length, 0)
  })

  it('writes one provider profile per route that holds models', async () => {
    const { settings, route } = mount({ plan: 'pro' })
    const payload = await withFetch(upstreamFetch(), () => drive(route('/sync')))
    assert.equal(payload.ok, true)
    // Both protocols commit in one revision-fenced operation.
    assert.deepEqual(settings.state.mutations.map((mutation) => mutation.ns), [LLM_PI_AI])
    const [openaiOp, anthropicOp] = settings.state.mutations[0].ops
    assert.equal(openaiOp.path.join('.'), 'providers.commandcode-pro-autosync')
    assert.equal(anthropicOp.path.join('.'), 'providers.commandcode-pro-anthropic')

    const openai = openaiOp.value
    assert.equal(openai.api, 'openai-completions')
    assert.equal(openai.baseURL, 'https://api.commandcode.ai/provider/v1')
    assert.equal(openai.apiKeyEnv, 'COMMANDCODE_API_KEY')
    assert.deepEqual(openai.compat, { thinkingFormat: 'openai', supportsReasoningEffort: true })
    assert.deepEqual(openai.models.map((model) => model.id), ['vendor/model-one'])
    assert.deepEqual(openai.models[0].input, ['text', 'image'])

    const anthropic = anthropicOp.value
    assert.equal(anthropic.api, 'anthropic-messages')
    assert.deepEqual(anthropic.compat, { forceAdaptiveThinking: true })
    assert.deepEqual(anthropic.models.map((model) => model.id), ['claude-sonnet-5'])
  })

  it('writes nothing on a dry run but still reports the counts', async () => {
    const { settings, route } = mount({ plan: 'goat' })
    const payload = await withFetch(upstreamFetch(), () => drive(route('/sync'), '{"dryRun":true}'))
    assert.equal(settings.state.mutations.length, 0)
    assert.equal(payload.value.dryRun, true)
    assert.equal(payload.value.live, 2)
    assert.deepEqual(payload.value.counts, {
      'commandcode-goat-autosync': 1,
      'commandcode-goat-anthropic': 0,
      'commandcode-goat-responses': 0,
    })
    // The card explains an absent channel from these counts, so they have to
    // reach it on the dry run too — the reader decides whether to write at all
    // based on exactly this report.
    assert.deepEqual(payload.value.channels, {
      openai: { endpoint: '/chat/completions', advertised: 1, assigned: 1 },
      anthropic: { endpoint: '/messages', advertised: 1, assigned: 0 },
      responses: { endpoint: '/responses', advertised: 0, assigned: 0 },
    })
  })

  it('probes every route it wrote, on the URL that route\u2019s own protocol builds', async () => {
    // This is the assertion that would have caught the Claude 404 on the day it
    // shipped: the settings card could only ever report that its own write
    // succeeded, so nothing noticed that `/provider/v1` + the Anthropic client's
    // own `/v1/messages` was asking for a path the gateway never registered.
    const envName = 'CC_ROUTE_PROBE_TEST'
    const previous = process.env[envName]
    process.env[envName] = 'fake-key'
    const probed = []
    try {
      const { settings, route } = mount({ plan: 'pro', targetApiKeyEnv: envName })
      const payload = await withFetch(async (url) => {
        const target = String(url)
        if (target.endsWith('models.md')) return { ok: true, status: 200, text: async () => EFFORT_REFERENCE }
        if (target.includes('/provider/v1/models')) return { ok: true, status: 200, json: async () => API_BODY }
        if (target.includes('/docs/plans/')) return { ok: true, status: 200, text: async () => goatPage(CATALOG_ENTRIES) }
        probed.push(target)
        // A gateway that does not serve the Claude path, exactly as Command Code
        // answers a path it does not register.
        if (target.endsWith('/messages')) {
          return { ok: false, status: 404, text: async () => '{"message":"404 Not found. Check the docs for available routes."}' }
        }
        return { ok: true, status: 200, text: async () => '{"ok":true}' }
      }, () => drive(route('/sync'), { diagnose: true }))

      assert.deepEqual(probed.sort(), [
        'https://api.commandcode.ai/provider/v1/chat/completions',
        'https://api.commandcode.ai/provider/v1/messages',
      ], 'the Claude route is probed on the root base, which is what its SDK needs')

      // A route that cannot answer is a fact to report, never a reason to undo
      // a write the harness may still serve.
      assert.equal(payload.ok, true)
      assert.equal(settings.state.mutations.length, 1)
      const byKey = Object.fromEntries(payload.value.routes.map((entry) => [entry.key, entry.probe]))
      assert.equal(byKey['commandcode-pro-autosync'].status, 200)
      assert.equal(byKey['commandcode-pro-autosync'].ok, true)
      assert.equal(byKey['commandcode-pro-anthropic'].status, 404)
      assert.equal(byKey['commandcode-pro-anthropic'].ok, false)
      assert.match(byKey['commandcode-pro-anthropic'].detail, /Not found/)
      assert.equal(byKey['commandcode-pro-anthropic'].model, 'claude-sonnet-5')
    } finally {
      if (previous === undefined) delete process.env[envName]
      else process.env[envName] = previous
    }
  })

  it('probes a route with the credential that route names, never this plugin\u2019s own', async () => {
    // A reader who points one route at another gateway also gives it another key.
    // Probing it with the plugin's key would hand a credential to a service it
    // was never issued for — something the harness itself never does.
    const own = 'CC_PROBE_OWN'
    const other = 'CC_PROBE_OTHER'
    const saved = [process.env[own], process.env[other]]
    process.env[own] = 'own-secret'
    process.env[other] = 'other-secret'
    try {
      const settings = mockSettings({
        entries: [
          {
            ns: LLM_PI_AI,
            revision: 1,
            value: {
              providers: {
                'commandcode-pro-autosync': { api: 'openai-completions', apiKeyEnv: other, baseURL: 'https://my.proxy/v1', models: [] },
              },
            },
            schema: { type: 'object', dict: { providers: {} } },
          },
          { ns: 'commandcode-goat', revision: 1, value: {} },
        ],
      })
      const webServer = mockWebServer()
      const { ctx } = mockContext({ settings, webServer })
      apply(ctx, Config({ plan: 'pro', targetApiKeyEnv: own }))
      const entry = webServer.state.routes.find((candidate) => candidate.path === `${BRIDGE_PREFIX}/sync`)

      const sent = []
      const payload = await withFetch(async (url, init) => {
        const target = String(url)
        if (target.endsWith('models.md')) return { ok: true, status: 200, text: async () => EFFORT_REFERENCE }
        if (target.includes('/provider/v1/models')) return { ok: true, status: 200, json: async () => API_BODY }
        if (target.includes('/docs/plans/')) return { ok: true, status: 200, text: async () => goatPage(CATALOG_ENTRIES) }
        sent.push({ url: target, headers: init?.headers ?? {}, redirect: init?.redirect })
        return { ok: true, status: 200, text: async () => '{}' }
      }, () => drive(entry, { diagnose: true }))

      assert.equal(payload.ok, true)
      const proxy = sent.find((call) => call.url === 'https://my.proxy/v1/chat/completions')
      assert.ok(proxy, 'the route the reader repointed is probed where it points')
      assert.equal(proxy.headers.authorization, 'Bearer other-secret')
      for (const call of sent.filter((candidate) => candidate.url.startsWith('https://my.proxy'))) {
        assert.equal(JSON.stringify(call.headers).includes('own-secret'), false, 'this plugin\u2019s key never reaches another host')
      }
      const claude = sent.find((call) => call.url === 'https://api.commandcode.ai/provider/v1/messages')
      assert.ok(claude)
      assert.equal(claude.headers['x-api-key'], 'own-secret')
      // A redirect is a verdict, not a place to forward `x-api-key` to.
      assert.deepEqual([...new Set(sent.map((call) => call.redirect))], ['manual'])
    } finally {
      for (const [index, name] of [own, other].entries()) {
        if (saved[index] === undefined) delete process.env[name]
        else process.env[name] = saved[index]
      }
    }
  })

  it('names a missing credential instead of probing unauthenticated', async () => {
    const { settings, route } = mount({ plan: 'pro', targetApiKeyEnv: 'CC_ROUTE_PROBE_ABSENT' })
    let probed = 0
    const payload = await withFetch(async (url) => {
      const target = String(url)
      // The effort reference is a public document, not a route probe: it never
      // carries the credential, so it does not belong in this count.
      if (target.endsWith('models.md')) return { ok: true, status: 200, text: async () => EFFORT_REFERENCE }
      if (target.includes('/provider/v1/models')) return { ok: true, status: 200, json: async () => API_BODY }
      if (target.includes('/docs/plans/')) return { ok: true, status: 200, text: async () => goatPage(CATALOG_ENTRIES) }
      probed += 1
      return { ok: true, status: 200, text: async () => '{"ok":true}' }
    }, () => drive(route('/sync')))
    assert.equal(payload.ok, true)
    assert.equal(probed, 0, 'nothing is sent without a credential')
    assert.equal(settings.state.mutations.length, 1)
    assert.deepEqual(payload.value.routes.map((entry) => entry.probe), [undefined, undefined])
  })

  it('does not publish unscoped models when the initial capability catalog is unavailable', async () => {
    const { settings, route } = mount({ plan: 'goat' })
    const payload = await withFetch(async (url) => (String(url).includes('/provider/v1/models')
      ? { ok: true, status: 200, json: async () => API_BODY }
      : { ok: false, status: 500, statusText: 'Server Error' }), () => drive(route('/sync')))
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'catalog-unavailable')
    assert.equal(settings.state.mutations.length, 0)
  })

  it('reports an unreachable model list as a coded failure', async () => {
    const { settings, route } = mount()
    const payload = await withFetch(async () => ({ ok: false, status: 503, statusText: 'Unavailable' }), () => drive(route('/sync')))
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'fetch-failed')
    assert.match(payload.message, /could not read the model list/)
    assert.equal(settings.state.mutations.length, 0)
  })

  it('reports a read-only deployment rather than silently doing nothing', async () => {
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings: mockSettings({ writable: false }), webServer })
    apply(ctx, Config({}))
    const route = webServer.state.routes.find((entry) => entry.path === `${BRIDGE_PREFIX}/sync`)
    const payload = await withFetch(upstreamFetch(), () => drive(route))
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'settings-read-only')
  })

  it('bounds its own network work with a timeout signal', () => {
    assert.ok(SYNC_TIMEOUT_MS > 0 && SYNC_TIMEOUT_MS <= 120_000)
  })

  it('removes the routes of the tier it left behind, and names them in the report', async () => {
    // Every tier writes its own keys, which is what makes a switch
    // non-destructive — and also what used to leave the previous tier's
    // providers in Settings → Models forever, listed under a nearly identical
    // name, on an account that no longer has that subscription.
    const settings = mockSettings({
      entries: [
        {
          ns: LLM_PI_AI,
          revision: 1,
          value: { providers: { 'commandcode-goat-autosync': { models: [{ id: 'old' }] } } },
          schema: { type: 'object', dict: { providers: {} } },
        },
        // The profile's own default model, pointing at the row about to go.
        { ns: 'agent-default-model', revision: 1, value: { provider: 'commandcode-goat-autosync', model: 'deepseek/deepseek-v4.1-flash' } },
      ],
    })
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings, webServer })
    await profileState(settings, 'commandcode-goat').update((saved) => {
      saved.plans.goat = { inventory: { openai: [{ id: 'old' }] } }
      return saved
    })
    const config = { plan: 'goat' }
    apply(ctx, config)
    config.plan = 'pro'
    const route = webServer.state.routes.find((entry) => entry.path === `${BRIDGE_PREFIX}/sync`)

    const payload = await withFetch(upstreamFetch(), () => drive(route))
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value.pruned, ['commandcode-goat-autosync'])
    // Deleting the row is only half of it: the profile still names it, and the
    // reader has to be told which section has to change.
    assert.match(payload.value.diagnostics.join('\n'), /still refers to a removed provider.*agent-default-model/s)
    const sweep = settings.state.mutations.at(-1)
    assert.equal(sweep.ns, LLM_PI_AI)
    assert.deepEqual(sweep.ops, [{ op: 'unset', path: ['providers', 'commandcode-goat-autosync'] }])
  })

  it('leaves the other tier alone when the sweep is switched off', async () => {
    const settings = mockSettings({
      entries: [{
        ns: LLM_PI_AI,
        revision: 1,
        value: { providers: { 'commandcode-goat-autosync': { models: [{ id: 'old' }] } } },
        schema: { type: 'object', dict: { providers: {} } },
      }],
    })
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings, webServer })
    apply(ctx, Config({ plan: 'pro', pruneOtherPlans: false }))
    const route = webServer.state.routes.find((entry) => entry.path === `${BRIDGE_PREFIX}/sync`)

    const payload = await withFetch(upstreamFetch(), () => drive(route))
    assert.deepEqual(payload.value.pruned, [])
    assert.ok(settings.state.mutations.every((mutation) => mutation.ops[0].op === 'set'))
  })

  it('sweeps on request even with nothing to sync', async () => {
    const settings = mockSettings({
      entries: [{
        ns: LLM_PI_AI,
        revision: 1,
        value: { providers: { 'commandcode-max-autosync': { models: [{ id: 'ghost' }] } } },
        schema: { type: 'object', dict: { providers: {} } },
      }],
    })
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings, webServer })
    await profileState(settings, 'commandcode-goat').update((saved) => {
      saved.plans.max = { inventory: { openai: [{ id: 'ghost' }] } }
      return saved
    })
    apply(ctx, Config({ plan: 'goat' }))
    const route = webServer.state.routes.find((entry) => entry.path === `${BRIDGE_PREFIX}/prune`)

    const payload = await drive(route)
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value.removed, ['commandcode-max-autosync'])
    assert.equal(payload.value.plan, 'goat')
  })

  it('reports old routes without a model baseline as protected instead of deleting them', async () => {
    const settings = mockSettings({ entries: [{ ns: LLM_PI_AI, revision: 1,
      value: { providers: { 'commandcode-max-autosync': { models: [{ id: 'legacy', contextWindow: 1234 }] } } },
      schema: { type: 'object', dict: { providers: {} } } }] })
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings, webServer })
    apply(ctx, Config({ plan: 'goat' }))
    const route = webServer.state.routes.find((entry) => entry.path === `${BRIDGE_PREFIX}/prune`)
    const payload = await drive(route)
    assert.deepEqual(payload.value.removed, [])
    assert.deepEqual(payload.value.protected, ['commandcode-max-autosync'])
    assert.equal(settings.state.mutations.length, 0)
  })

  it('describes all four tiers, and the routes of a plan that is not the selected one', async () => {
    const settings = mockSettings({
      entries: [{
        ns: LLM_PI_AI,
        revision: 1,
        value: {
          providers: {
            'commandcode-goat-autosync': { api: 'openai-completions', displayName: 'Command | goat', models: [{ id: 'a' }, { id: 'b' }] },
            'commandcode-pro-autosync': { models: [{ id: 'c' }] },
          },
        },
        schema: { type: 'object', dict: { providers: {} } },
      }],
    })
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings, webServer })
    apply(ctx, Config({ plan: 'goat' }))
    const describeRoute = webServer.state.routes.find((entry) => entry.path === `${BRIDGE_PREFIX}/describe`)

    // Offline, because a status read now reaches for the catalog itself: with
    // no source answering, the counts are absent rather than zero, which is the
    // state the tier cards have to render without inventing a number.
    const payload = await withFetch(async () => { throw new TypeError('offline') }, () => drive(describeRoute))
    const value = payload.value
    assert.deepEqual(value.plans, ['go', 'goat', 'pro', 'max'])
    assert.deepEqual(value.tiers.map((tier) => tier.plan), ['go', 'goat', 'pro', 'max'])
    assert.deepEqual(value.tiers.map((tier) => tier.models), [null, null, null, null])
    const goat = value.tiers.find((tier) => tier.plan === 'goat')
    assert.deepEqual(goat.routes, ['openai'])
    assert.equal(goat.selected, true)
    assert.equal(goat.provider, 'Command | goat')
    // Every field the browser half reads off a tier row, straight from the real
    // host: a tier card without these renders with no quota, no link and no tag,
    // and degrades silently rather than failing loudly.
    assert.deepEqual(goat.variants, [{ label: 'GOAT', price: 10, fiveHour: 14, weekly: 35, monthly: 70 }])
    assert.equal(goat.docURL, 'https://commandcode.ai/docs/plans/goat')
    assert.equal(goat.title, 'GOAT')
    assert.equal(goat.subscribed, false)
    assert.equal(goat.source, null)
    assert.deepEqual(value.tiers.find((tier) => tier.plan === 'max').variants.map((variant) => variant.label), ['Max 10×', 'Max 20×'])
    assert.deepEqual(value.stale, [{ key: 'commandcode-pro-autosync', plan: 'pro', slot: 'openai', models: 1 }])
    assert.deepEqual(value.targets.openai, {
      key: 'commandcode-goat-autosync',
      slot: 'openai',
      channel: 'AutoSync',
      api: 'openai-completions',
      created: true,
      models: 2,
      displayName: 'Command | goat',
    })
  })

  it('names the tier counts once a sync has read both sources', async () => {
    const { route } = mount({ plan: 'pro' })
    await withFetch(upstreamFetch(), () => drive(route('/sync'), '{"dryRun":true}'))
    const payload = await drive(route('/describe'))
    const tiers = payload.value.tiers
    // The fixture catalog holds one Go model and one Pro model, and the live
    // list serves both.
    assert.deepEqual(tiers.map((tier) => tier.models), [1, 1, 2, 2])
    assert.deepEqual(tiers.map((tier) => tier.live), [1, 1, 2, 2])
  })

  it('reads the catalog for a status call that arrives before any sync', async () => {
    // The first sync is deliberately fifteen seconds after mount, and a reader
    // who opens the card inside that window used to see four tiers with no
    // figures beside them at all. The status read now pays for the one page
    // those figures need.
    const { route } = mount({ plan: 'goat' })
    const urls = []
    const payload = await withFetch(async (url) => {
      urls.push(String(url))
      if (String(url).includes('/provider/v1/models')) return { ok: true, status: 200, json: async () => API_BODY }
      return { ok: true, status: 200, text: async () => goatPage(CATALOG_ENTRIES) }
    }, () => drive(route('/describe')))

    assert.deepEqual(urls.filter((url) => url.includes('/docs/plans/')), ['https://commandcode.ai/docs/plans/goat'])
    assert.deepEqual(payload.value.tiers.map((tier) => tier.models), [1, 1, 2, 2])
    // Only the catalog was read, so the live count stays honestly unknown
    // rather than being reported as zero.
    assert.deepEqual(payload.value.tiers.map((tier) => tier.live), [null, null, null, null])
  })

  it('still answers a status call when the catalog cannot be read at all', async () => {
    const { route } = mount({ plan: 'goat' })
    const payload = await withFetch(async () => ({ ok: false, status: 503, statusText: 'Unavailable' }), () => drive(route('/describe')))
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value.tiers.map((tier) => tier.models), [null, null, null, null])
  })
})

describe('readCatalog', () => {
  it('follows the selected tier’s own page', async () => {
    const urls = []
    const result = await withFetch(async (url) => {
      urls.push(String(url))
      return { ok: true, status: 200, text: async () => goatPage(CATALOG_ENTRIES) }
    }, () => readCatalog({ catalogURL: DEFAULT_CATALOG_URL, plan: 'go' }))
    assert.deepEqual(urls, ['https://commandcode.ai/docs/plans/go'])
    assert.equal(result.source, 'https://commandcode.ai/docs/plans/go')
    assert.equal(result.fallbackFrom, undefined)
    assert.equal(result.entries.length, 2)
  })

  it('falls back to the page that always states the catalog', async () => {
    // The Max page publishes no catalog array, and a Max subscriber used to get
    // an unenriched sync for no reason at all.
    const urls = []
    const result = await withFetch(async (url) => {
      urls.push(String(url))
      return String(url).endsWith('/max')
        ? { ok: true, status: 200, text: async () => '<html><body>no payload here</body></html>' }
        : { ok: true, status: 200, text: async () => goatPage(CATALOG_ENTRIES) }
    }, () => readCatalog({ catalogURL: DEFAULT_CATALOG_URL, plan: 'max' }))
    assert.deepEqual(urls, ['https://commandcode.ai/docs/plans/max', 'https://commandcode.ai/docs/plans/goat'])
    assert.equal(result.source, 'https://commandcode.ai/docs/plans/goat')
    assert.equal(result.fallbackFrom, 'https://commandcode.ai/docs/plans/max')
  })

  it('uses a source the reader typed verbatim, without following the tier', async () => {
    const urls = []
    await withFetch(async (url) => {
      urls.push(String(url))
      return { ok: true, status: 200, text: async () => goatPage(CATALOG_ENTRIES) }
    }, () => readCatalog({ catalogURL: 'https://mirror.example/catalog', plan: 'max' }))
    assert.deepEqual(urls, ['https://mirror.example/catalog'])
  })

  it('reports every candidate it tried when none of them answered', async () => {
    await assert.rejects(
      () => withFetch(async () => ({ ok: false, status: 503, statusText: 'Unavailable' }), () => readCatalog({ catalogURL: DEFAULT_CATALOG_URL, plan: 'max' })),
      (error) => {
        assert.match(error.message, /docs\/plans\/max/)
        assert.match(error.message, /docs\/plans\/goat/)
        return true
      },
    )
  })
})

describe('the usage tool', () => {
  it('cancels an active account request when the plugin unloads', async () => {
    const tools = mockTools()
    const credentials = { resolve: async () => ({ value: 'fake-key' }) }
    const { ctx, effects } = mockContext({ tools, credentials })
    apply(ctx, Config({}))
    let calls = 0
    let aborted = false
    await assert.rejects(withFetch(async (_url, { signal }) => {
      calls += 1
      for (const effect of [...effects].reverse()) effect.dispose?.()
      aborted = signal.aborted
      throw signal.reason
    }, () => tools.state.tools[0].execute({}, {})), { code: 'account-changed' })
    assert.equal(aborted, true)
    assert.equal(calls, 1)
  })
  it('returns a labelled summary a model can read', async () => {
    const tools = mockTools()
    const { ctx } = mockContext({ settings: mockSettings(), tools })
    apply(ctx, Config({}))
    const tool = tools.state.tools[0]
    const originalKey = process.env.COMMANDCODE_API_KEY
    process.env.COMMANDCODE_API_KEY = 'cmd_test'
    try {
      const text = await withFetch(async (url) => ({
        ok: true,
        status: 200,
        json: async () => String(url).endsWith('/credits') ? { credits: {} }
          : String(url).endsWith('/subscriptions') ? { data: { planId: 'individual-goat' } } : ({
          user: { id: 'u1', userName: 'ada' },
          planId: 'individual-goat',
          totalCount: 4,
          completedCount: 4,
          successRate: 1,
          totalCost: 0.5,
          totalTokensIn: 100,
          totalTokensOut: 20,
        }),
      }), () => tool.execute({}, {}))
      assert.match(text, /account: ada/)
      assert.match(text, /"failures": \[\]/)
    } finally {
      if (originalKey === undefined) delete process.env.COMMANDCODE_API_KEY
      else process.env.COMMANDCODE_API_KEY = originalKey
    }
  })

  it('names the missing credential instead of throwing a raw error', async () => {
    const tools = mockTools()
    const { ctx } = mockContext({ settings: mockSettings(), tools })
    apply(ctx, Config({ targetApiKeyEnv: 'CC_GOAT_TEST_MISSING' }))
    const originalKey = process.env.CC_GOAT_TEST_MISSING
    delete process.env.CC_GOAT_TEST_MISSING
    try {
      await assert.rejects(
        () => tools.state.tools[0].execute({}, {}),
        /no "CC_GOAT_TEST_MISSING" credential is configured/,
      )
    } finally {
      if (originalKey !== undefined) process.env.CC_GOAT_TEST_MISSING = originalKey
    }
  })
})

/**
 * The mounted plugin has to recover the gateway refusal on the routes *it*
 * generated — under the tier the config currently selects, and no other — so
 * that the published context window can stay the vendor's.
 */
describe('upstream-overflow recovery, as mounted', () => {
  /** The 400 Command Code returns for a request its gateway cannot expand. */
  const GATEWAY_REFUSAL = {
    code: 'INVALID_REQUEST',
    message: '400: {"message":"{\\"message\\":\\"a single path expansion cannot exceed 512 candidates trace_id: 49d472f289d9707a8e4bc4814eca2360\\",\\"type\\":\\"invalid_request_error\\"}\\n","type":"invalid_request_error"}',
  }

  /** Mount the plugin and hand back the middleware the agent loop would run. */
  function mount(config = {}, services = {}) {
    const session = {
      surface: { replaceGeneration: 0 },
      requestHeader: () => ({ config: { provider: 'commandcode-goat-autosync', model: 'deepseek/deepseek-v4.1-flash' } }),
    }
    const pruner = {
      calls: 0,
      pruneSession(target) {
        this.calls += 1
        target.surface.replaceGeneration += 1
        // The real pruner answers with the replacements it landed, not a count.
        return { pruned: [{ originalSeq: 1 }, { originalSeq: 2 }, { originalSeq: 3 }], charsRemoved: 9000 }
      },
    }
    const { ctx, listeners } = mockContext({ toolResultPruner: pruner, ...services })
    apply(ctx, Config(config))
    assert.ok(listeners.has('agent/request-error'), 'the recovery hook was not registered')
    const refuse = (provider = 'commandcode-goat-autosync', failure = GATEWAY_REFUSAL) => ctx.waterfall('agent/request-error', {
      agent: { session },
      provider,
      failure,
    })
    return { ctx, pruner, session, refuse }
  }

  it('prunes and retries on the generated route of the configured tier', async () => {
    const { pruner, session, refuse } = mount({ plan: 'goat' })
    assert.deepEqual(await refuse('commandcode-goat-autosync'), { kind: 'retry' })
    assert.equal(pruner.calls, 1)
    assert.equal(session.surface.replaceGeneration, 1)
  })

  it('follows the tier the config selects, not the tier it started on', async () => {
    const { refuse } = mount({ plan: 'max' })
    assert.equal(await refuse('commandcode-goat-autosync'), undefined)
    assert.deepEqual(await refuse('commandcode-max-autosync'), { kind: 'retry' })
  })

  it('leaves the request alone when the switch is off', async () => {
    const { pruner, refuse } = mount({ recoverUpstreamOverflow: false })
    assert.equal(await refuse(), undefined)
    assert.equal(pruner.calls, 0)
  })

  it('claims a dropped stream only with the guard ratio the config carries', async () => {
    // The same wiring the guard uses has to reach the ladder, or a session can
    // be reduced early and still die on the first request that fails.
    const DROPPED = { code: 'TRANSPORT', message: 'Stream ended without finish_reason' }
    const services = { tokenMeter: { measure: () => ({ totalTokens: 798_935 }) }, llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 } }) } }
    const on = mount({ plan: 'goat' }, services)
    assert.deepEqual(await on.refuse('commandcode-goat-autosync', DROPPED), { kind: 'retry' })

    const off = mount({ plan: 'goat', contextGuardRatio: 0 }, services)
    assert.equal(await off.refuse('commandcode-goat-autosync', DROPPED), undefined)
    assert.equal(off.pruner.calls, 0)
  })
})

describe('context guard, as mounted', () => {
  /** The decision the harness' own pre-step fallback returns, unchanged. */
  const HARNESS_CONTINUE = { kind: 'enter', messages: [] }

  /**
   * Mount the plugin with the two host services the guard reads, and hand back
   * the middleware the agent loop would run before a step.
   */
  function mount(config = {}) {
    const session = {
      surface: { replaceGeneration: 0 },
      requestHeader: () => ({ config: { provider: 'commandcode-goat-autosync', model: 'deepseek/deepseek-v4.1-flash' } }),
    }
    const pruner = {
      calls: 0,
      pruneSession(target) {
        this.calls += 1
        target.surface.replaceGeneration += 1
        return { pruned: [{ originalSeq: 1 }], charsRemoved: 500 }
      },
    }
    const { ctx, listeners } = mockContext({
      toolResultPruner: pruner,
      tokenMeter: { measure: () => ({ totalTokens: 798_935 }) },
      llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 } }) },
    })
    const live = Config(config)
    apply(ctx, live)
    assert.ok(listeners.has('agent/pre-step'), 'the guard was not registered')
    const step = async (provider) => {
      const decision = await ctx.waterfall('agent/pre-step', {
        agent: { session: provider === undefined ? session : { ...session, requestHeader: () => ({ config: { provider, model: 'deepseek/deepseek-v4.1-flash' } }) } },
        turn: 1,
        step: 1,
      }, HARNESS_CONTINUE)
      assert.deepEqual(decision, HARNESS_CONTINUE, 'the guard must pass the step decision through untouched')
      return undefined
    }
    return { ctx, live, pruner, session, step }
  }

  it('reduces the session before the request on the generated route', async () => {
    const { pruner, session, step } = mount({ plan: 'goat' })
    assert.equal(await step(), undefined)
    assert.equal(pruner.calls, 1)
    assert.equal(session.surface.replaceGeneration, 1)
  })

  it('follows the tier the config selects, not the tier it started on', async () => {
    const { pruner, step } = mount({ plan: 'max' })
    assert.equal(await step('commandcode-goat-autosync'), undefined)
    assert.equal(pruner.calls, 0)
    assert.equal(await step('commandcode-max-autosync'), undefined)
    assert.equal(pruner.calls, 1)
  })

  it('is switched off by its own ratio or by the shared switch', async () => {
    const off = mount({ contextGuardRatio: 0 })
    assert.equal(await off.step(), undefined)
    assert.equal(off.pruner.calls, 0)

    const disabled = mount({ recoverUpstreamOverflow: false })
    assert.equal(await disabled.step(), undefined)
    assert.equal(disabled.pruner.calls, 0)
  })

  it('reads the ratio live, so a settings write reaches a running guard', async () => {
    // Volatile fields arrive as live references: mutating this object is what a
    // settings write does to a running instance, and a guard that captured the
    // ratio at mount would keep firing at the old budget until a restart.
    const { pruner, live, step } = mount({ contextGuardRatio: 0 })
    assert.equal(await step(), undefined)
    assert.equal(pruner.calls, 0)

    live.contextGuardRatio = 0.9
    assert.equal(await step(), undefined)
    assert.equal(pruner.calls, 0, 'a ratio at or above the harness line is no guard')

    live.contextGuardRatio = 0.5
    assert.equal(await step(), undefined)
    assert.equal(pruner.calls, 1)

    live.contextGuardRatio = 0
    assert.equal(await step(), undefined)
    assert.equal(pruner.calls, 1)
  })
})
