import { createHash } from 'node:crypto'
import { validateModelPreferences, stableJSON } from './model-management.js'
import { validateAlertThresholds } from './account-notifications.js'

export const CONFIGURATION_FORMAT = 'dsh-commandcode-goat/preferences'
export const CONFIGURATION_VERSION = 1
export const PORTABLE_FIELDS = ['plan', 'autoSync', 'autoSyncIntervalMs', 'pruneOtherPlans', 'webSearch', 'enableUsageTool',
  'effortSourceURL', 'recoverUpstreamOverflow', 'contextGuardRatio', 'maxContextWindow', 'extraIds',
  'modelPreferences', 'onlyFavorites', 'alertThresholds', 'modelChangeNotifications']
const FLAGS = ['autoSync', 'pruneOtherPlans', 'webSearch', 'enableUsageTool',
  'recoverUpstreamOverflow', 'onlyFavorites', 'modelChangeNotifications']
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function validatePortableConfiguration(input) {
  if (!record(input)) throw new TypeError('configuration must be an object')
  const config = {}
  for (const [key, value] of Object.entries(input)) {
    if (!PORTABLE_FIELDS.includes(key)) throw new TypeError(`configuration field is not portable: ${key}`)
    if (FLAGS.includes(key) && typeof value !== 'boolean') throw new TypeError(`${key} must be boolean`)
    if (key === 'plan' && !['go', 'goat', 'pro', 'max'].includes(value)) throw new TypeError('unknown subscription tier')
    if (key === 'autoSyncIntervalMs' && (!Number.isSafeInteger(value) || value < 60000)) throw new TypeError('sync interval must be an integer >=60000ms')
    if (key === 'contextGuardRatio' && (!Number.isFinite(value) || value < 0 || value > 1)) throw new TypeError('guard ratio must be between 0 and 1')
    if (key === 'maxContextWindow' && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError('context cap must be a non-negative integer')
    if (key === 'extraIds' && (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.trim()))) {
      throw new TypeError('extraIds must contain non-empty strings')
    }
    config[key] = key === 'modelPreferences' ? validateModelPreferences(value)
      : key === 'alertThresholds' ? validateAlertThresholds(value) : structuredClone(value)
  }
  return config
}

/** Deliberately excludes credentials, credential refs, hosts, headers and source URLs. */
export function exportConfiguration(config, now = Date.now()) {
  const portable = Object.fromEntries(PORTABLE_FIELDS.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]))
  return { format: CONFIGURATION_FORMAT, version: CONFIGURATION_VERSION, exportedAt: new Date(now).toISOString(),
    configuration: validatePortableConfiguration(portable) }
}

export const configurationSignature = (value) => createHash('sha256').update(stableJSON(value)).digest('hex')

export function previewConfigurationImport(document, current, mode = 'merge') {
  if (typeof document === 'string') {
    if (Buffer.byteLength(document, 'utf8') > 1024 * 1024) throw new TypeError('configuration file exceeds 1 MiB')
    document = JSON.parse(document)
  }
  if (!record(document) || document.format !== CONFIGURATION_FORMAT || document.version !== CONFIGURATION_VERSION) {
    throw new TypeError('unsupported configuration format/version')
  }
  if (!['merge', 'replace'].includes(mode)) throw new TypeError('import mode must be merge or replace')
  const imported = validatePortableConfiguration(document.configuration)
  const before = exportConfiguration(current, 0).configuration
  const next = mode === 'replace' ? imported : { ...before, ...imported,
    ...imported.modelPreferences === undefined ? {} : { modelPreferences: { ...before.modelPreferences, ...imported.modelPreferences } } }
  const changes = [...new Set([...Object.keys(before), ...Object.keys(next)])].filter((key) => stableJSON(before[key]) !== stableJSON(next[key]))
    .map((key) => ({ key, op: next[key] === undefined ? 'unset' : 'set', value: next[key] }))
  return { mode, configuration: next, changes, baseSignature: configurationSignature(before),
    warnings: ['Credentials, credential references, endpoints and request headers are not imported.'] }
}
