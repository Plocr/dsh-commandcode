import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyModelPreferences, diffModels, preserveModelOverrides, validateModelPreferences } from '../lib/model-management.js'
import { evaluateAlerts, appendNotifications, modelChangeEvents } from '../lib/account-notifications.js'
import { exportConfiguration, previewConfigurationImport, CONFIGURATION_FORMAT } from '../lib/configuration-transfer.js'

const routes = { openai: [{ id: 'a', name: 'A', input: ['text'], contextWindow: 100000, reasoningEfforts: { medium: 'medium' } },
  { id: 'b', input: ['text', 'image'] }], anthropic: [], responses: [] }
describe('model selection and explicit policies', () => {
  it('filters favorites and hidden models, and applies reasoning/cap preferences', () => {
    const next = applyModelPreferences(routes, { onlyFavorites: true, maxContextWindow: 16000,
      effortLevels: { a: ['off', 'high', 'max'] },
      preferences: { a: { favorite: true, reasoningPreset: 'deep', maxTokens: 2048 }, b: { favorite: true, hidden: true } } })
    assert.deepEqual(next.openai.map((model) => model.id), ['a'])
    // `deep` is the model's own top rung, not the word "high": on a ladder that
    // stops at `max`, naming `high` would quietly pick a middle rung.
    assert.deepEqual(next.openai[0].reasoningEfforts, { off: 'off', max: 'max' })
    assert.equal(next.openai[0].contextWindow, 16000)
    assert.equal(next.openai[0].maxTokens, 2048)
    assert.equal(routes.openai[0].contextWindow, 100000)
  })
  it('resolves balanced against the ladder instead of naming medium', () => {
    const pumped = applyModelPreferences(routes, {
      preferences: { a: { reasoningPreset: 'balanced' } },
      effortLevels: { a: ['off', 'high', 'max'] },
    })
    assert.deepEqual(pumped.openai[0].reasoningEfforts, { off: 'off', high: 'high' })

    // No reference entry: the generated map is left exactly as the sync wrote
    // it rather than being overwritten with a level the model may not have.
    const untouched = applyModelPreferences(routes, { preferences: { a: { reasoningPreset: 'balanced' } } })
    assert.deepEqual(untouched.openai[0].reasoningEfforts, { medium: 'medium' })
  })
  it('rejects invalid mappings, bad caps and unsafe ids', () => {
    for (const preference of [{ contextWindow: 1.5 }, { maxTokens: -1 }, { reasoningPreset: 'custom' },
      { reasoningEfforts: { off: null } }, { reasoningEfforts: { high: null } }, { surprise: true }]) {
      assert.throws(() => validateModelPreferences({ a: preference }))
    }
    assert.throws(() => validateModelPreferences(JSON.parse('{"__proto__":{}}')))
  })
  it('keeps manual fields while refreshing fields that were not edited', () => {
    const before = { openai: [{ id: 'a', name: 'Old', contextWindow: 100000, maxTokens: 1000 }] }
    const providers = { 'commandcode-goat-autosync': { models: [{ id: 'a', name: 'Old', contextWindow: 50000, maxTokens: 1000 }] } }
    const proposed = { openai: [{ id: 'a', name: 'New', contextWindow: 200000, maxTokens: 2000 }] }
    const result = preserveModelOverrides(proposed, providers, before, 'goat')
    assert.deepEqual(result.routes.openai[0], { id: 'a', name: 'New', contextWindow: 50000, maxTokens: 2000 })
    assert.deepEqual(result.kept.map((field) => field.field), ['contextWindow'])
  })
  it('produces a preview diff with additions, removals and changed capabilities', () => {
    const next = { openai: [{ ...routes.openai[0], input: ['text', 'image'] }, { id: 'c' }] }
    const diff = diffModels(routes, next)
    assert.deepEqual(diff.summary, { added: 1, removed: 1, updated: 1, total: 2 })
    assert.deepEqual(diff.updated[0].fields, ['input'])
    assert.equal(modelChangeEvents(diff, 123).length, 3)
  })
})
describe('quota reminders and change notifications', () => {
  it('alerts once on crossing, re-arms after recovery and respects window reset', () => {
    const thresholds = { enabled: true }
    const report = (used, resetAt = 10) => ({ credits: { fiveHour: { used, cap: 100, resetAt } } })
    const first = evaluateAlerts(report(85), thresholds, {}, 1)
    assert.equal(first.events.length, 1)
    assert.equal(evaluateAlerts(report(90), thresholds, first.state, 2).events.length, 0)
    const outage = evaluateAlerts({}, thresholds, first.state, 2)
    assert.equal(evaluateAlerts(report(90), thresholds, outage.state, 3).events.length, 0)
    const recovered = evaluateAlerts(report(50), thresholds, first.state, 3)
    assert.equal(evaluateAlerts(report(85), thresholds, recovered.state, 4).events.length, 1)
    assert.equal(evaluateAlerts(report(85, 20), thresholds, first.state, 5).events.length, 1)
  })
  it('does not invent zero balances when fields are missing and bounds/deduplicates history', () => {
    assert.equal(evaluateAlerts({ credits: {} }, { enabled: true }).events.length, 0)
    assert.deepEqual(appendNotifications([{ id: 'old' }], [{ id: 'new' }, { id: 'new' }], 1), [{ id: 'new' }])
    assert.equal(evaluateAlerts({ credits: { monthlyCredits: 1, purchasedCredits: 0, freeCredits: 0 } }, { enabled: false }).events.length, 0)
  })
})
describe('portable configuration transfer', () => {
  it('does not export keys, credential references, endpoints or headers', () => {
    const doc = exportConfiguration({ plan: 'goat', modelPreferences: { a: { favorite: true } }, targetApiKeyEnv: 'SECRET_REF',
      targetBaseURL: 'https://secret-host.invalid', targetCompat: {}, headers: { authorization: 'secret' }, apiKey: 'secret' }, 0)
    const serialized = JSON.stringify(doc)
    assert.equal(serialized.includes('secret'), false)
    assert.equal(serialized.includes('SECRET_REF'), false)
    assert.deepEqual(Object.keys(doc.configuration), ['plan', 'modelPreferences'])
  })
  it('previews merge and replace without changing the current configuration', () => {
    const current = { plan: 'goat', modelPreferences: { a: { favorite: true } }, onlyFavorites: false }
    const doc = exportConfiguration({ plan: 'pro', modelPreferences: { b: { hidden: true } } }, 0)
    const merged = previewConfigurationImport(doc, current)
    assert.deepEqual(Object.keys(merged.configuration.modelPreferences), ['a', 'b'])
    assert.equal(current.plan, 'goat')
    const replaced = previewConfigurationImport(doc, current, 'replace')
    assert.ok(replaced.changes.some((op) => op.key === 'onlyFavorites' && op.op === 'unset'))
    assert.equal(merged.baseSignature.length, 64)
  })
  it('rejects unsupported or connection-changing imports', () => {
    assert.throws(() => previewConfigurationImport({ format: CONFIGURATION_FORMAT, version: 2 }, {}))
    assert.throws(() => previewConfigurationImport({ format: CONFIGURATION_FORMAT, version: 1,
      configuration: { targetBaseURL: 'https://evil.invalid' } }, {}))
  })
})
