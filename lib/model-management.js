import { providerKey, ROUTE_ORDER } from './catalog.js'

export const REASONING_PRESETS = ['auto', 'off', 'balanced', 'deep', 'custom']
export const MODEL_OVERRIDE_FIELDS = ['name', 'input', 'contextWindow', 'maxTokens', 'reasoningEfforts', 'compat']
const EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const ALLOWED = new Set(['favorite', 'hidden', 'reasoningPreset', 'reasoningEfforts', 'contextWindow', 'maxTokens'])
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`
  if (object(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function validateModelPreferences(value = {}) {
  if (!object(value)) throw new TypeError('modelPreferences must be an object')
  const entries = []
  for (const [id, preference] of Object.entries(value)) {
    if (!id.trim() || ['__proto__', 'prototype', 'constructor'].includes(id)) throw new TypeError('invalid model id')
    if (!object(preference)) throw new TypeError(`modelPreferences.${id} must be an object`)
    for (const key of Object.keys(preference)) if (!ALLOWED.has(key)) throw new TypeError(`unknown model preference: ${key}`)
    for (const key of ['favorite', 'hidden']) {
      if (preference[key] !== undefined && typeof preference[key] !== 'boolean') throw new TypeError(`${id}.${key} must be boolean`)
    }
    for (const key of ['contextWindow', 'maxTokens']) {
      if (preference[key] !== undefined && (!Number.isSafeInteger(preference[key]) || preference[key] <= 0)) {
        throw new TypeError(`${id}.${key} must be a positive integer`)
      }
    }
    if (preference.reasoningPreset !== undefined && !REASONING_PRESETS.includes(preference.reasoningPreset)) {
      throw new TypeError(`${id}: unknown reasoning preset`)
    }
    const mapping = preference.reasoningEfforts
    if (mapping !== undefined) {
      if (!object(mapping) || !Object.keys(mapping).some((key) => key !== 'off')) throw new TypeError(`${id}: empty reasoning mapping`)
      for (const [level, wire] of Object.entries(mapping)) {
        if (!EFFORTS.has(level) || !(typeof wire === 'string' && wire.trim() || level === 'off' && wire === null)) {
          throw new TypeError(`${id}: invalid reasoning mapping ${level}`)
        }
      }
    }
    if (preference.reasoningPreset === 'custom' && mapping === undefined) throw new TypeError(`${id}: custom reasoning needs a mapping`)
    entries.push([id, structuredClone(preference)])
  }
  return Object.fromEntries(entries)
}

/**
 * The `reasoningEfforts` a preset stands for on one model.
 *
 * A preset is a *relative* choice — "the middle rung", "the top rung" — so it
 * has to be resolved against the model's own ladder. Writing `medium` onto a
 * model whose ladder is `off/high/max` used to name a level the model does not
 * have and, before that, one the gateway would silently clamp.
 *
 * @param levels - the model's levels from the effort reference, if known.
 * @param kind - `balanced` or `deep`.
 * @returns the map to write, or `undefined` when nothing is known about the model.
 */
function presetEfforts(levels, kind) {
  if (!Array.isArray(levels) || levels.length === 0) return undefined
  const thinking = levels.filter((level) => level !== 'off')
  if (thinking.length === 0) return undefined
  const pick = kind === 'deep'
    ? thinking[thinking.length - 1]
    : thinking.includes('medium') ? 'medium' : thinking[Math.floor((thinking.length - 1) / 2)]
  const map = {}
  // `off` is a real wire value on the models that have it; leaving it out means
  // "send no parameter", which does not stop a model that thinks by default.
  if (levels.includes('off')) map.off = 'off'
  map[pick] = pick
  return map
}

/** Apply explicit choices after discovery; hidden always wins over favorite. */
export function applyModelPreferences(routes, { preferences = {}, onlyFavorites = false, maxContextWindow = 0, effortLevels = {} } = {}) {
  const validated = validateModelPreferences(preferences)
  return Object.fromEntries(ROUTE_ORDER.map((route) => [route, (routes?.[route] ?? []).flatMap((model) => {
    const pref = validated[model.id] ?? {}
    if (pref.hidden || onlyFavorites && !pref.favorite) return []
    const next = structuredClone(model)
    for (const key of ['contextWindow', 'maxTokens']) if (pref[key] !== undefined) next[key] = pref[key]
    if (maxContextWindow > 0) next.contextWindow = Math.min(next.contextWindow ?? maxContextWindow, maxContextWindow)
    if (pref.reasoningPreset === 'off') next.reasoningEfforts = false
    if (pref.reasoningPreset === 'balanced' || pref.reasoningPreset === 'deep') {
      const preset = presetEfforts(effortLevels?.[model.id], pref.reasoningPreset)
      if (preset !== undefined) next.reasoningEfforts = preset
    }
    if (pref.reasoningPreset === 'custom') next.reasoningEfforts = structuredClone(pref.reasoningEfforts)
    return [next]
  })]))
}

/** Preserve explicit model edits by comparing live values to the last generated values. */
export function preserveModelOverrides(routes, providers, previousGenerated, plan) {
  const kept = []
  const next = Object.fromEntries(ROUTE_ORDER.map((route) => {
    const live = new Map((providers?.[providerKey(plan, route)]?.models ?? []).map((model) => [model.id, model]))
    const baseline = new Map((previousGenerated?.[route] ?? []).map((model) => [model.id, model]))
    return [route, (routes?.[route] ?? []).map((model) => {
      const current = live.get(model.id)
      if (!current) return structuredClone(model)
      const previous = baseline.get(model.id)
      const result = structuredClone(model)
      for (const field of MODEL_OVERRIDE_FIELDS) {
        if (current[field] === undefined) continue
        // Legacy migration has no baseline. Keep differing capability values
        // conservatively; names remain managed until a baseline exists.
        if (!previous && field === 'name') continue
        if (stableJSON(current[field]) === stableJSON((previous ?? model)[field])) continue
        result[field] = structuredClone(current[field])
        kept.push({ route, id: model.id, field, legacy: !previous })
      }
      return result
    })]
  }))
  return { routes: next, kept }
}

export function inventoryFromProviders(providers, plan) {
  return Object.fromEntries(ROUTE_ORDER.map((route) => [route, structuredClone(providers?.[providerKey(plan, route)]?.models ?? [])]))
}

export function diffModels(previous, next) {
  const flatten = (routes) => new Map(ROUTE_ORDER.flatMap((route) => (routes?.[route] ?? []).map((model) => [`${route}/${model.id}`, { route, ...model }])))
  const before = flatten(previous), after = flatten(next)
  const added = [], removed = [], updated = []
  for (const [key, model] of after) {
    if (!before.has(key)) added.push(model)
    else if (stableJSON(before.get(key)) !== stableJSON(model)) {
      const old = before.get(key)
      const fields = [...new Set([...Object.keys(old), ...Object.keys(model)])]
        .filter((field) => stableJSON(old[field]) !== stableJSON(model[field]))
      updated.push({ route: model.route, id: model.id, fields, before: old, after: model })
    }
  }
  for (const [key, model] of before) if (!after.has(key)) removed.push(model)
  return { added, removed, updated, unchanged: after.size - added.length - updated.length,
    summary: { added: added.length, removed: removed.length, updated: updated.length, total: after.size } }
}
