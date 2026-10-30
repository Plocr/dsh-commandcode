import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_OPENAI_COMPAT,
  LLM_PI_AI_NS,
  SYNC_CODES,
  SyncError,
  buildRouteProfile,
  piAiSection,
  pruneGeneratedRoutes,
  readPiAiValue,
  sectionsReferencing,
  syncPlan,
  upsertProvider,
} from '../lib/pi-ai.js'

/** Apply one `{op,path,value}` op the way the settings service does. */
function applyOp(section, op) {
  const [head, ...rest] = op.path
  if (head === undefined) return op.op === 'unset' ? {} : { ...op.value }
  if (rest.length === 0) {
    if (op.op === 'set') return { ...section, [head]: op.value }
    const { [head]: _removed, ...kept } = section
    return kept
  }
  const child = section[head]
  const base = child !== null && typeof child === 'object' && !Array.isArray(child) ? child : {}
  return { ...section, [head]: applyOp(base, { ...op, path: rest }) }
}

/**
 * A stand-in for the settings service, faithful about the three things this
 * plugin depends on: `describe` returns resolved sections, `mutate` applies
 * path ops, and a write carries the revision it read.
 */
function fakeSettings({ value = {}, writable = true, registered = true, conflicts = 0, onConflict, onMutate, entries } = {}) {
  const state = { value, revision: 7, writes: [], remainingConflicts: conflicts }
  return {
    writable,
    get value() {
      return state.value
    },
    get writes() {
      return state.writes
    },
    describe() {
      if (!registered) return []
      return entries ?? [{
        ns: LLM_PI_AI_NS,
        value: state.value,
        revision: state.revision,
        schema: { type: 'object', dict: { providers: {} } },
      }]
    },
    async mutate(ns, ops, revision) {
      state.writes.push({ ns, ops, revision })
      if (state.remainingConflicts > 0) {
        state.remainingConflicts -= 1
        state.revision += 1
        if (onConflict) state.value = onConflict(state.value)
        throw Object.assign(new Error(`namespace "${ns}" changed since it was read`), { code: 'SETTINGS_CONFLICT' })
      }
      onMutate?.(ops)
      for (const op of ops) state.value = applyOp(state.value, op)
      state.revision += 1
      return state.value
    },
  }
}

const ENTRIES = [
  { id: 'vendor/a', name: 'A', input: ['text'] },
  { id: 'claude-b', name: 'B', input: ['text', 'image'] },
]

describe('buildRouteProfile', () => {
  it('states everything a route needs to be served', () => {
    const profile = buildRouteProfile({ key: 'commandcode-goat-autosync', route: 'openai', entries: ENTRIES, plan: 'goat' })
    assert.equal(profile.api, 'openai-completions')
    assert.equal(profile.apiKeyEnv, 'COMMANDCODE_API_KEY')
    assert.equal(profile.baseURL, 'https://api.commandcode.ai/provider/v1')
    assert.equal(profile.models, ENTRIES)
    assert.deepEqual(profile.compat, DEFAULT_OPENAI_COMPAT)
    assert.equal(profile.displayName, 'Command | goat')
  })

  it('gives the two channels of one tier names a reader can tell apart', () => {
    // This is the whole point of the naming rule: the harness prints one row per
    // route, so two routes sharing a name read as one provider listed twice.
    assert.equal(buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'go' }).displayName, 'Command | go')
    assert.equal(buildRouteProfile({ key: 'k', route: 'anthropic', entries: ENTRIES, plan: 'goat' }).displayName, 'Command | goat · Claude')
    assert.equal(buildRouteProfile({ key: 'k', route: 'responses', entries: ENTRIES, plan: 'max' }).displayName, 'Command | max · Responses')
    const names = ['openai', 'anthropic', 'responses'].map((route) => buildRouteProfile({ key: 'k', route, entries: ENTRIES, plan: 'pro' }).displayName)
    assert.equal(new Set(names).size, names.length)
  })

  it('writes only the compat fields each protocol offers', () => {
    // The Anthropic route takes exactly one switch here: this gateway serves
    // Claude with adaptive thinking (`thinking.type: "adaptive"` +
    // `output_config.effort`) and refuses the budget-based shape outright, so
    // the route states it. It must not borrow the OpenAI vocabulary, which the
    // provider plugin would reject on this protocol.
    const anthropic = buildRouteProfile({ key: 'k', route: 'anthropic', entries: ENTRIES, plan: 'pro' })
    assert.deepEqual(anthropic.compat, { forceAdaptiveThinking: true })

    const responses = buildRouteProfile({ key: `commandcode-pro-responses`, route: 'responses', entries: ENTRIES, plan: 'pro' })
    assert.equal('compat' in responses, false, 'responses must not carry compat')
    assert.equal(anthropic.api, 'anthropic-messages')
    assert.equal(responses.api, 'openai-responses')
  })

  it('honours a deployment override, and treats an empty one as absent', () => {
    const overridden = buildRouteProfile({
      key: 'k',
      route: 'openai',
      entries: ENTRIES,
      plan: 'max',
      cfg: { targetApiKeyEnv: 'MY_KEY', targetBaseURL: 'https://gateway.test/v1', targetCompat: { thinkingFormat: 'deepseek' } },
    })
    assert.equal(overridden.apiKeyEnv, 'MY_KEY')
    assert.equal(overridden.baseURL, 'https://gateway.test/v1')
    assert.deepEqual(overridden.compat, { thinkingFormat: 'deepseek' })

    // Schemastery materializes an absent `targetCompat` as `{}`, which states
    // nothing — it must not replace the reasoning-enabling default.
    const empty = buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'max', cfg: { targetCompat: {} } })
    assert.deepEqual(empty.compat, DEFAULT_OPENAI_COMPAT)
  })

  it('gives the Claude route the API root, not the versioned base', () => {
    // The Anthropic client appends `/v1/messages` itself, so the versioned base
    // it shares with the OpenAI-shaped routes produced `/provider/v1/v1/messages`
    // — the gateway's 404 — while the route looked correctly configured.
    const anthropic = buildRouteProfile({ key: 'commandcode-goat-anthropic', route: 'anthropic', entries: ENTRIES, plan: 'goat' })
    assert.equal(anthropic.baseURL, 'https://api.commandcode.ai/provider')
    assert.equal(buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'goat' }).baseURL, 'https://api.commandcode.ai/provider/v1')
    assert.equal(buildRouteProfile({ key: 'k', route: 'responses', entries: ENTRIES, plan: 'goat' }).baseURL, 'https://api.commandcode.ai/provider/v1')

    // The same rule holds for a deployment's own base URL.
    const overridden = buildRouteProfile({ key: 'k', route: 'anthropic', entries: ENTRIES, plan: 'goat', cfg: { targetBaseURL: 'https://gateway.test/v1' } })
    assert.equal(overridden.baseURL, 'https://gateway.test/v1'.replace(/\/v1$/, ''))
  })
})

describe('piAiSection', () => {
  it('returns undefined when the service or the namespace is absent', () => {
    assert.equal(piAiSection(undefined), undefined)
    assert.equal(piAiSection({}), undefined)
    assert.equal(piAiSection(fakeSettings({ registered: false })), undefined)
  })

  it('finds the section under a renamed row', () => {
    // dsh 0.1.7 keys a settings section by the row the profile composed it
    // under, and the profile owns that id — so the section is identified by the
    // `providers` dict its schema carries when the shipped id is not there.
    const renamed = fakeSettings({
      entries: [{ ns: 'pi-ai', revision: 3, value: { providers: {} }, schema: { type: 'object', dict: { providers: {} } } }],
    })
    assert.equal(piAiSection(renamed)?.ns, 'pi-ai')
  })

  it('reads an empty section when the provider serves nothing yet', () => {
    assert.deepEqual(readPiAiValue(fakeSettings({ value: {} })), {})
  })
})

describe('upsertProvider', () => {
  it('creates a route that does not exist yet', async () => {
    const settings = fakeSettings()
    const profile = buildRouteProfile({ key: 'commandcode-goat-autosync', route: 'openai', entries: ENTRIES, plan: 'goat' })
    const result = await upsertProvider({ settings, key: 'commandcode-goat-autosync', profile })
    assert.deepEqual(result, { key: 'commandcode-goat-autosync', count: 2, created: true })
    assert.deepEqual(settings.writes[0].ops, [
      { op: 'set', path: ['providers', 'commandcode-goat-autosync'], value: profile },
    ])
    assert.equal(settings.value.providers['commandcode-goat-autosync'].models.length, 2)
  })

  it('passes the revision it read to the write', async () => {
    const settings = fakeSettings()
    await upsertProvider({ settings, key: 'k', profile: { models: [] } })
    assert.equal(settings.writes[0].revision, 7)
  })

  it('refreshes an existing route without touching the user\u2019s key, base URL or compat', async () => {
    const existing = {
      apiKeyEnv: 'MY_KEY',
      baseURL: 'https://my.proxy/v1',
      api: 'openai-completions',
      compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: false },
      models: [{ id: 'stale' }],
    }
    const settings = fakeSettings({ value: { providers: { 'commandcode-goat-autosync': existing } } })
    const profile = buildRouteProfile({ key: 'commandcode-goat-autosync', route: 'openai', entries: ENTRIES, plan: 'goat' })
    const result = await upsertProvider({ settings, key: 'commandcode-goat-autosync', profile })

    assert.equal(result.created, false)
    assert.deepEqual(settings.writes[0].ops, [
      { op: 'set', path: ['providers', 'commandcode-goat-autosync', 'displayName'], value: 'Command | goat' },
      { op: 'set', path: ['providers', 'commandcode-goat-autosync', 'models'], value: ENTRIES },
    ])
    const written = settings.value.providers['commandcode-goat-autosync']
    assert.equal(written.apiKeyEnv, 'MY_KEY')
    assert.equal(written.baseURL, 'https://my.proxy/v1')
    assert.deepEqual(written.compat, { thinkingFormat: 'deepseek', supportsReasoningEffort: false })
    assert.deepEqual(written.models, ENTRIES)
  })

  it('repairs the Claude base URL an earlier version of this plugin wrote', async () => {
    // The route was written with the versioned base, which the Anthropic client
    // turns into `/provider/v1/v1/messages` — a 404 for every Claude model. That
    // value is unsatisfiable rather than chosen, so a re-sync replaces it.
    const settings = fakeSettings({
      value: {
        providers: {
          'commandcode-goat-anthropic': {
            apiKeyEnv: 'COMMANDCODE_API_KEY',
            api: 'anthropic-messages',
            baseURL: 'https://api.commandcode.ai/provider/v1',
            displayName: 'Command | goat · Claude',
            models: [],
          },
        },
      },
    })
    const profile = buildRouteProfile({ key: 'commandcode-goat-anthropic', route: 'anthropic', entries: ENTRIES, plan: 'goat' })
    const result = await upsertProvider({ settings, key: 'commandcode-goat-anthropic', profile })
    assert.equal(result.created, false)
    assert.equal(settings.value.providers['commandcode-goat-anthropic'].baseURL, 'https://api.commandcode.ai/provider')
  })

  it('still leaves a Claude base URL the user chose alone', async () => {
    for (const base of ['https://my.proxy/provider', 'https://my.proxy/v2', 'https://my.proxy/provider/v1/']) {
      const settings = fakeSettings({
        value: { providers: { k: { apiKeyEnv: 'A', api: 'anthropic-messages', baseURL: base, displayName: 'Mine', models: [] } } },
      })
      await upsertProvider({ settings, key: 'k', profile: buildRouteProfile({ key: 'k', route: 'anthropic', entries: ENTRIES, plan: 'goat' }) })
      // A base that cannot be served from is repaired; every other answer stands.
      const expected = base.endsWith('/v1/') ? 'https://my.proxy/provider' : base
      assert.equal(settings.value.providers.k.baseURL, expected, base)
      assert.equal(settings.value.providers.k.displayName, 'Mine')
    }
  })

  it('leaves a display name the user chose alone', async () => {
    const settings = fakeSettings({
      value: { providers: { k: { displayName: '我的网关', api: 'openai-completions', baseURL: 'x', apiKeyEnv: 'A', models: [] } } },
    })
    await upsertProvider({ settings, key: 'k', profile: buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'goat' }) })
    assert.equal(settings.value.providers.k.displayName, '我的网关')
  })

  it('renames a route this plugin named before the naming rule, so the upgrade is visible', async () => {
    // 0.6.x wrote `Command Code GOAT` onto every route of a tier, which is what
    // made two channels of one subscription read as two identical providers.
    // A name that is on this plugin's own historical list is therefore
    // rewritten; a name the reader typed is not.
    const settings = fakeSettings({
      value: { providers: { k: { displayName: 'Command Code GOAT', api: 'openai-completions', baseURL: 'x', apiKeyEnv: 'A', models: [] } } },
    })
    await upsertProvider({ settings, key: 'k', profile: buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'goat' }) })
    assert.equal(settings.value.providers.k.displayName, 'Command | goat')
  })

  it('leaves an already-correct generated name out of the write', async () => {
    const settings = fakeSettings({
      value: {
        providers: {
          k: {
            displayName: 'Command | goat',
            api: 'openai-completions',
            baseURL: 'x',
            apiKeyEnv: 'A',
            compat: { thinkingFormat: 'openai', supportsReasoningEffort: true },
            models: [],
          },
        },
      },
    })
    await upsertProvider({ settings, key: 'k', profile: buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'goat' }) })
    assert.deepEqual(settings.writes[0].ops, [{ op: 'set', path: ['providers', 'k', 'models'], value: ENTRIES }])
  })

  it('fills in a compat dict schemastery left empty', async () => {
    const settings = fakeSettings({ value: { providers: { k: { api: 'openai-completions', baseURL: 'x', apiKeyEnv: 'A', compat: {}, models: [] } } } })
    const profile = buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'goat' })
    await upsertProvider({ settings, key: 'k', profile })
    assert.deepEqual(settings.value.providers.k.compat, DEFAULT_OPENAI_COMPAT)
  })

  it('refuses to overwrite a route the user built with modelOverrides', async () => {
    const settings = fakeSettings({ value: { providers: { k: { modelOverrides: { 'x/y': { contextWindow: 1000 } } } } } })
    await assert.rejects(
      () => upsertProvider({ settings, key: 'k', profile: buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'goat' }) }),
      (error) => {
        assert.ok(error instanceof SyncError)
        assert.equal(error.code, SYNC_CODES.overrides)
        assert.match(error.message, /modelOverrides/)
        return true
      },
    )
    assert.equal(settings.writes.length, 0)
  })

  it('resyncs a route whose modelOverrides the settings service materialized as an empty dict', async () => {
    // `settings.describe()` returns the section schemastery already parsed, and
    // schemastery turns an absent dict into `{}`. Reading the *presence* of the
    // key instead of its content made every re-sync of an existing route refuse
    // itself with "declares modelOverrides" — on a route that declared none.
    const settings = fakeSettings({
      value: {
        providers: {
          k: {
            api: 'openai-completions',
            baseURL: 'https://api.commandcode.ai/provider/v1',
            apiKeyEnv: 'COMMANDCODE_API_KEY',
            compat: { thinkingFormat: 'openai', supportsReasoningEffort: true },
            modelOverrides: {},
            models: [],
          },
        },
      },
    })
    const profile = buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'goat' })
    const result = await upsertProvider({ settings, key: 'k', profile })
    assert.equal(result.created, false)
    assert.deepEqual(settings.value.providers.k.models, ENTRIES)
  })

  it('retries once when the section moved under it', async () => {
    const settings = fakeSettings({ conflicts: 1 })
    const result = await upsertProvider({ settings, key: 'k', profile: { models: ENTRIES } })
    assert.equal(result.created, true)
    assert.equal(settings.writes.length, 2)
    assert.equal(settings.writes[1].revision, 8, 'the second attempt re-read the moved revision')
  })

  it('reports a conflict that survives the retry as a coded failure', async () => {
    const settings = fakeSettings({ conflicts: 5 })
    await assert.rejects(
      () => upsertProvider({ settings, key: 'k', profile: { models: [] } }),
      (error) => error.code === SYNC_CODES.conflict,
    )
  })

  it('refuses to write where there is nowhere to write', async () => {
    await assert.rejects(() => upsertProvider({ settings: undefined, key: 'k', profile: {} }), (error) => error.code === SYNC_CODES.noSettings)
    await assert.rejects(
      () => upsertProvider({ settings: fakeSettings({ registered: false }), key: 'k', profile: {} }),
      (error) => {
        assert.equal(error.code, SYNC_CODES.noProvider)
        assert.match(error.message, /llm-pi-ai/)
        return true
      },
    )
    await assert.rejects(
      () => upsertProvider({ settings: fakeSettings({ writable: false }), key: 'k', profile: {} }),
      (error) => error.code === SYNC_CODES.readOnly,
    )
  })

  it('turns a provider-plugin rejection into a coded failure with its message', async () => {
    const settings = fakeSettings({
      onMutate() {
        throw new Error('llm-pi-ai: provider "k" model "vendor/a" needs an api')
      },
    })
    await assert.rejects(
      () => upsertProvider({ settings, key: 'k', profile: { models: [] } }),
      (error) => {
        assert.equal(error.code, SYNC_CODES.rejected)
        assert.match(error.message, /needs an api/)
        return true
      },
    )
  })
})

describe('concurrent settings edits', () => {
  it('preserves a route created by another writer before retrying', async () => {
    const settings = fakeSettings({ conflicts: 1, onConflict: () => ({ providers: {
      k: { apiKeyEnv: 'USER_KEY', baseURL: 'https://proxy.test', displayName: 'Custom', models: [] },
    } }) })
    const profile = buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'goat' })
    const result = await upsertProvider({ settings, key: 'k', profile })
    assert.equal(result.created, false)
    assert.equal(settings.value.providers.k.apiKeyEnv, 'USER_KEY')
    assert.equal(settings.value.providers.k.baseURL, 'https://proxy.test')
    assert.equal(settings.value.providers.k.displayName, 'Custom')
    assert.deepEqual(settings.value.providers.k.models, ENTRIES)
  })

  it('rejects overrides added while an upsert was conflicting', async () => {
    const settings = fakeSettings({ conflicts: 1, onConflict: () => ({ providers: {
      k: { modelOverrides: { a: {} } },
    } }) })
    await assert.rejects(() => upsertProvider({ settings, key: 'k', profile: { models: ENTRIES } }),
      (error) => error.code === SYNC_CODES.overrides)
    assert.equal(settings.writes.length, 1)
  })

  it('protects overrides added while a deletion was conflicting', async () => {
    const key = 'commandcode-pro-autosync'
    const settings = fakeSettings({ value: { providers: { [key]: { models: [] } } }, conflicts: 1,
      onConflict: () => ({ providers: { [key]: { modelOverrides: { a: {} } } } }) })
    const result = await pruneGeneratedRoutes({ settings, plan: 'goat' })
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.protected, [key])
    assert.ok(settings.value.providers[key])
    assert.equal(settings.writes.length, 1)
  })
})

describe('syncPlan', () => {
  const routes = { openai: ENTRIES, anthropic: [], responses: [] }

  it('keeps an empty route with hand-edited configuration or models', async () => {
    const key = 'commandcode-goat-anthropic'
    for (const customized of [
      { modelOverrides: { a: { contextWindow: 4096 } } },
      { baseURL: 'https://custom.example', models: [{ id: 'old' }] },
      { headers: { 'x-custom': 'value' }, models: [{ id: 'old' }] },
      { models: [{ id: 'old', contextWindow: 4096 }] },
    ]) {
      const settings = fakeSettings({ value: { providers: { [key]: customized } } })
      const result = await syncPlan({ settings, plan: 'goat', routes,
        previousInventory: { anthropic: [{ id: 'old', contextWindow: 8192 }] } })
      assert.deepEqual(result.protected, [key])
      assert.deepEqual(settings.value.providers[key], customized)
    }
  })

  it('refuses a changed provider snapshot on settings conflict retry', async () => {
    const key = 'commandcode-goat-autosync'
    const original = { [key]: { models: [{ id: 'old' }] } }
    const settings = fakeSettings({ value: { providers: structuredClone(original) }, conflicts: 1,
      onConflict: () => ({ providers: { [key]: { models: [{ id: 'old', contextWindow: 1234 }] } } }) })
    await assert.rejects(() => syncPlan({ settings, plan: 'goat', routes, expectedProviders: original,
      staleCode: 'preview-stale' }), { code: 'preview-stale' })
    assert.equal(settings.value.providers[key].models[0].contextWindow, 1234)
    assert.equal(settings.writes.length, 1)
  })

  it('validates every channel before writing the tier', async () => {
    const settings = fakeSettings({ value: { providers: {
      'commandcode-pro-anthropic': { modelOverrides: { a: {} } },
    } } })
    await assert.rejects(() => syncPlan({ settings, plan: 'pro', routes: {
      openai: ENTRIES, anthropic: ENTRIES,
    } }), (error) => error.code === SYNC_CODES.overrides)
    assert.equal(settings.writes.length, 0)
    assert.equal(settings.value.providers['commandcode-pro-autosync'], undefined)
  })

  it('commits all channels in a single mutation', async () => {
    const settings = fakeSettings()
    const result = await syncPlan({ settings, plan: 'pro', routes: {
      openai: ENTRIES, anthropic: ENTRIES,
    } })
    assert.equal(settings.writes.length, 1)
    assert.equal(result.routes.length, 2)
    assert.ok(settings.value.providers['commandcode-pro-anthropic'])
    assert.ok(settings.value.providers['commandcode-pro-autosync'])
  })

  it('writes the routes that hold models and reports the empty ones as skipped', async () => {
    const settings = fakeSettings()
    const result = await syncPlan({ settings, plan: 'goat', routes })
    assert.equal(result.routes.length, 1)
    assert.equal(result.routes[0].key, 'commandcode-goat-autosync')
    assert.deepEqual(result.skipped, ['anthropic', 'responses'])
  })

  it('writes a second route for a tier that holds Claude models', async () => {
    const settings = fakeSettings()
    const result = await syncPlan({ settings, plan: 'pro', routes: { openai: [], anthropic: ENTRIES, responses: [] } })
    assert.deepEqual(result.routes.map((route) => route.key), ['commandcode-pro-anthropic'])
    assert.equal(settings.value.providers['commandcode-pro-anthropic'].api, 'anthropic-messages')
  })

  it('reports an empty selection rather than creating an unservable route', async () => {
    const settings = fakeSettings()
    await assert.rejects(
      () => syncPlan({ settings, plan: 'goat', routes: { openai: [], anthropic: [], responses: [] } }),
      (error) => {
        assert.equal(error.code, SYNC_CODES.nothing)
        assert.match(error.message, /GOAT/)
        return true
      },
    )
    assert.equal(settings.writes.length, 0)
  })
})

describe('sectionsReferencing', () => {
  /** The two sections that name a provider in the profile this plugin runs in. */
  const profile = {
    describe: () => [
      { ns: LLM_PI_AI_NS, value: { providers: {} } },
      { ns: 'agent-default-model', value: { provider: 'commandcode-goat-autosync', model: 'x' } },
      { ns: 'subagent-model-selection', value: { allowedModels: [{ provider: 'commandcode-pro-autosync', model: 'y' }] } },
      { ns: 'ui-theme', value: { preference: 'system' } },
    ],
  }

  it('names the sections that still point at a route that was just removed', () => {
    // Deleting a provider row can strand the profile's default model, and a
    // dangling provider reference is a model picker that loses its default with
    // no explanation at all.
    assert.deepEqual(sectionsReferencing(profile, ['commandcode-goat-autosync']), ['agent-default-model: commandcode-goat-autosync'])
    assert.deepEqual(
      sectionsReferencing(profile, ['commandcode-goat-autosync', 'commandcode-pro-autosync']),
      ['agent-default-model: commandcode-goat-autosync', 'subagent-model-selection: commandcode-pro-autosync'],
    )
  })

  it('never reports the provider section it just wrote to', () => {
    assert.deepEqual(sectionsReferencing({ describe: () => [{ ns: LLM_PI_AI_NS, value: { providers: { 'commandcode-goat-autosync': {} } } }] }, ['commandcode-goat-autosync']), [])
  })

  it('skips a renamed provider section and matches complete keys', () => {
    const key = 'commandcode-goat-autosync'
    const settings = { describe: () => [
      { ns: 'renamed-pi', schema: { dict: { providers: {} } }, value: { providers: { [key]: {} } } },
      { ns: 'other', value: { provider: `${key}-custom` } },
      { ns: 'default-model', value: { provider: key } },
    ] }
    assert.deepEqual(sectionsReferencing(settings, [key]), [`default-model: ${key}`])
  })

  it('also catches a route written as one provider-qualified model id', () => {
    // `"commandcode-goat-autosync/deepseek/deepseek-v4.1-flash"` names the same
    // route as the two-field form, and the profile is not the only place that
    // can hold it. A key that merely *starts* the same way still must not match.
    const key = 'commandcode-goat-autosync'
    const settings = { describe: () => [
      { ns: 'qualified', value: { model: `${key}/deepseek/deepseek-v4.1-flash` } },
      { ns: 'similar', value: { model: `${key}-2/deepseek/deepseek-v4.1-flash` } },
      { ns: 'bare-prefix', value: { note: `${key} rules` } },
    ] }
    assert.deepEqual(sectionsReferencing(settings, [key]), [`qualified: ${key}`])
  })

  it('answers nothing for nothing, and survives a section it cannot read', async () => {
    assert.deepEqual(sectionsReferencing(profile, []), [])
    assert.deepEqual(sectionsReferencing(undefined, ['k']), [])
    const circular = { self: undefined }
    circular.self = circular
    assert.deepEqual(sectionsReferencing({ describe: () => [{ ns: 'weird', value: circular }] }, ['k']), [])
  })
})

describe('pruneGeneratedRoutes', () => {
  const providers = {
    'commandcode-goat-autosync': { models: [{ id: 'a' }] },
    'commandcode-goat-anthropic': { models: [{ id: 'claude-a' }] },
    'commandcode-pro-autosync': { models: [{ id: 'a' }, { id: 'b' }] },
    'commandcode-max-autosync': { models: [{ id: 'a' }] },
  }

  it('removes the other tiers and keeps the selected one', async () => {
    const settings = fakeSettings({ value: { providers: { ...providers } } })
    const result = await pruneGeneratedRoutes({ settings, plan: 'goat' })

    assert.deepEqual(result.removed.sort(), ['commandcode-max-autosync', 'commandcode-pro-autosync'])
    assert.deepEqual(result.kept.sort(), ['commandcode-goat-anthropic', 'commandcode-goat-autosync'])
    assert.deepEqual(Object.keys(settings.value.providers).sort(), ['commandcode-goat-anthropic', 'commandcode-goat-autosync'])
    // One write for the whole sweep, so a partial prune cannot happen.
    assert.equal(settings.writes.length, 1)
    assert.deepEqual(settings.writes[0].ops, [
      { op: 'unset', path: ['providers', 'commandcode-pro-autosync'] },
      { op: 'unset', path: ['providers', 'commandcode-max-autosync'] },
    ])
  })

  it('never touches a route it did not generate', async () => {
    const settings = fakeSettings({
      value: {
        providers: {
          ...providers,
          'my-own-gateway': { models: [] },
          'commandcode-goat-custom': { models: [] },
          commandcode: { models: [] },
        },
      },
    })
    const result = await pruneGeneratedRoutes({ settings, plan: 'goat' })
    assert.deepEqual(result.removed.sort(), ['commandcode-max-autosync', 'commandcode-pro-autosync'])
    for (const key of ['my-own-gateway', 'commandcode-goat-custom', 'commandcode']) {
      assert.ok(settings.value.providers[key] !== undefined, `${key} must survive`)
    }
  })

  it('reports a route the user customized instead of deleting it', async () => {
    const settings = fakeSettings({
      value: {
        providers: {
          ...providers,
          'commandcode-pro-anthropic': { modelOverrides: { 'x/y': { contextWindow: 1000 } }, models: [] },
        },
      },
    })
    const result = await pruneGeneratedRoutes({ settings, plan: 'goat' })
    assert.deepEqual(result.protected, ['commandcode-pro-anthropic'])
    assert.ok(settings.value.providers['commandcode-pro-anthropic'] !== undefined)
    assert.ok(!result.removed.includes('commandcode-pro-anthropic'))
  })

  it('protects custom connection settings and modified models while pruning', async () => {
    const settings = fakeSettings({ value: { providers: {
      'commandcode-pro-autosync': { baseURL: 'https://custom.example', models: [{ id: 'a' }] },
      'commandcode-max-autosync': { models: [{ id: 'a', contextWindow: 1234 }] },
    } } })
    const result = await pruneGeneratedRoutes({ settings, plan: 'goat', previousInventories: {
      pro: { openai: [{ id: 'a' }] }, max: { openai: [{ id: 'a', contextWindow: 8192 }] },
    } })
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.protected.sort(), ['commandcode-max-autosync', 'commandcode-pro-autosync'])
  })

  it('writes nothing when there is nothing stale, and limits itself to the keys it is given', async () => {
    const settings = fakeSettings({ value: { providers: { 'commandcode-goat-autosync': { models: [] } } } })
    const result = await pruneGeneratedRoutes({ settings, plan: 'goat' })
    assert.deepEqual(result, { plan: 'goat', removed: [], kept: ['commandcode-goat-autosync'], protected: [] })
    assert.equal(settings.writes.length, 0)

    const scoped = fakeSettings({ value: { providers: { ...providers } } })
    const limited = await pruneGeneratedRoutes({ settings: scoped, plan: 'goat', keys: ['commandcode-pro-autosync'] })
    assert.deepEqual(limited.removed, ['commandcode-pro-autosync'])
    assert.ok(scoped.value.providers['commandcode-max-autosync'] !== undefined)
  })

  it('refuses to sweep where there is nowhere to write', async () => {
    await assert.rejects(
      () => pruneGeneratedRoutes({ settings: fakeSettings({ registered: false }), plan: 'goat' }),
      (error) => error.code === SYNC_CODES.noProvider,
    )
  })
})
