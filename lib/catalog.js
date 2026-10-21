/**
 * Command Code plan catalog — model discovery and mapping.
 *
 * Pure module: no Cordis, no DSH, no I/O beyond the two fetchers, so every
 * parsing and mapping rule below is unit-testable with plain `node --test`.
 *
 * It answers three questions:
 *
 *   1. Which models does Command Code serve right now, and on which wire
 *      protocol does each one live?
 *   2. Which of those are inside the subscription tier the user selected?
 *   3. What does `llm-pi-ai` need to hear about each model — context window,
 *      input modalities, whether reasoning may be sent at all?
 *
 * Two upstream sources are joined:
 *
 *   - `GET /provider/v1/models` — the live, authoritative list. Each entry
 *     carries `id`, `name`, `context_length` and, since the gateway update of
 *     2026-09, `supported_endpoints`. That last field is the *routing truth*:
 *     a Claude model sent to `/chat/completions` is rejected with 400, and an
 *     id-prefix heuristic only approximates the same answer.
 *   - The plan docs page — the official per-model capability catalog
 *     (`reasoning` / `vision` / `caps` / `minPlanName`), which the models
 *     endpoint does not expose at all. It is embedded in the page's React
 *     Server Components payload, so it is read from there.
 *
 * The docs catalog is an *enrichment*: if it cannot be fetched or parsed, the
 * live list alone still produces a serviceable route set, minus capability
 * metadata and tier filtering. Callers report that as a degraded sync.
 */

import { BUNDLED_EFFORTS, effortMap } from './efforts.js'

/** Live model list (OpenAI-shaped `{ data: [...] }`). */
export const DEFAULT_SOURCE_URL = 'https://api.commandcode.ai/provider/v1/models'
/**
 * Plan page carrying the capability catalog.
 *
 * The Go, GOAT and Pro pages publish the same array; the Max page publishes a
 * different payload with no catalog in it at all. `plans.js` owns the
 * per-tier candidate list and the fallback, which is why the default here is
 * the page that always answers.
 */
export const DEFAULT_CATALOG_URL = 'https://commandcode.ai/docs/plans/goat'
/** Chat base: everything under `/provider/v1` speaks one of the chat protocols. */
export const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider/v1'
/** API root. Usage and search live on `/alpha/*`, outside the chat base. */
export const DEFAULT_ALPHA_BASE_URL = 'https://api.commandcode.ai'
/** Credential reference the generated routes resolve their key through. */
export const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY'

/**
 * Selectable subscription tiers, cheapest first.
 *
 * `go` is a real subscription — the vendor's billing API returns
 * `individual-go` for it — and it is the one tier whose models are *only* its
 * own: every other tier is strictly cumulative above it.
 */
export const PLANS = ['go', 'goat', 'pro', 'max']

/** Display names for the tiers, in the vendor's own spelling. */
export const PLAN_TITLES = { go: 'Go', goat: 'GOAT', pro: 'Pro', max: 'Max' }

/**
 * Tier membership, expressed the way the official pages express it: a tier
 * *includes* every model whose `minPlanName` it is at or above. `max` is the
 * top tier, so it admits every catalog entry including ones naming a tier
 * this build has never heard of.
 *
 * `Go` and `GOAT` are different tiers that share a prefix, which is exactly the
 * shape a `startsWith` test gets wrong: a Go subscriber is entitled to the
 * models the catalog marks `Go` and to none of the `GOAT` ones.
 */
const PLAN_MIN = {
  go: new Set(['Go']),
  goat: new Set(['Go', 'GOAT']),
  pro: new Set(['Go', 'GOAT', 'Pro']),
  max: null,
}

/** Every `minPlanName` the catalog is known to use. */
const KNOWN_MIN_PLANS = new Set(['Go', 'GOAT', 'Pro', 'Max'])

/**
 * The three wire protocols a `llm-pi-ai` route can declare, keyed by the route
 * slot this module sorts models into. `suffix` is the generated provider name's
 * tail: `commandcode-<plan>-<suffix>`. `endpoint` is the gateway path the
 * protocol belongs to — the same string `supported_endpoints` publishes — which
 * is what lets a sync say why a channel came out empty instead of only that it
 * did.
 */
export const ROUTES = {
  openai: { protocol: 'openai-completions', suffix: 'autosync', endpoint: '/chat/completions' },
  anthropic: { protocol: 'anthropic-messages', suffix: 'anthropic', endpoint: '/messages' },
  responses: { protocol: 'openai-responses', suffix: 'responses', endpoint: '/responses' },
}

/** Route slots in the order a sync creates them. */
export const ROUTE_ORDER = ['openai', 'anthropic', 'responses']

/** The `llm-pi-ai` provider key one tier's route is written to. */
export function providerKey(plan, route) {
  const entry = ROUTES[route]
  if (entry === undefined) throw new TypeError(`unknown route ${JSON.stringify(route)}`)
  return `commandcode-${plan}-${entry.suffix}`
}

/** The wire protocol one route slot speaks. */
export function routeProtocol(route) {
  const entry = ROUTES[route]
  if (entry === undefined) throw new TypeError(`unknown route ${JSON.stringify(route)}`)
  return entry.protocol
}

/**
 * The `baseURL` one route must be given.
 *
 * The field is read by the *protocol's own SDK*, and the two SDKs disagree
 * about what it names:
 *
 *   - OpenAI-shaped clients (`openai-completions`, `openai-responses`) treat it
 *     as the versioned API root and append only the operation path
 *     (`/chat/completions`, `/responses`). Command Code's `…/provider/v1` is
 *     exactly right for those.
 *   - The Anthropic client treats it as the host root and appends
 *     `/v1/messages` itself. Handed the same `…/provider/v1` it asks for
 *     `…/provider/v1/v1/messages`, which no gateway registers — Command Code
 *     answers that path with `404 Not found. Check the docs for available
 *     routes.` and the model is unusable while the route looks correctly
 *     configured.
 *
 * So a trailing `/v1` is dropped for `anthropic-messages` and only there. Only
 * that exact segment is touched: a gateway mounted at another version, or at a
 * bare root, passes through unchanged, and the value stays idempotent — the
 * listing URL the adapter builds for this protocol (`{base}/v1/models`) lands
 * back on the gateway's real `/provider/v1/models`.
 *
 * @param route - the route slot (`openai`, `anthropic`, `responses`).
 * @param base - the configured chat base URL.
 * @returns the base URL to write onto that route.
 */
export function routeBaseURL(route, base) {
  const value = String(base ?? '').trim().replace(/\/+$/, '')
  if (routeProtocol(route) !== 'anthropic-messages') return value
  return value.replace(/\/v1$/i, '')
}

/**
 * The URL a request on this route actually reaches, SDK path and all.
 *
 * This is the other half of {@link routeBaseURL}: the base each protocol wants
 * *plus* the path its own client appends. Stating it here is what lets the
 * plugin check its own work — a route is only usable if this URL answers, and
 * nothing downstream of the LLM adapter can tell a wrong URL from an
 * unreachable one (the adapter reports both as a message, never as a status).
 *
 * @param route - the route slot (`openai`, `anthropic`, `responses`).
 * @param base - the base URL written onto that route.
 * @returns the absolute request URL for that route.
 */
export function routeRequestURL(route, base) {
  const value = routeBaseURL(route, base)
  const suffix = routeProtocol(route) === 'anthropic-messages' ? '/v1/messages' : ROUTES[route].endpoint
  return `${value}${suffix}`
}

/** Lowercase, punctuation-free form used to match ids against catalog slugs. */
export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Which route one model belongs on.
 *
 * `supported_endpoints` from the live list decides whenever it is present,
 * because it is the gateway stating its own terms. The order below matters:
 * a model served on both chat and messages endpoints is taken as OpenAI-shaped
 * — that is the wider protocol and the one whose request shape the model's
 * non-Anthropic siblings share. The catalog's `vendor` and an id prefix are
 * only reached for a gateway that predates the field.
 *
 * @param model - live-list entry (`id`, optional `supportedEndpoints`).
 * @param catalogEntry - matching catalog entry, when one was found.
 * @returns the route slot to sort this model into.
 */
export function routeForModel(model, catalogEntry) {
  const endpoints = Array.isArray(model?.supportedEndpoints) ? model.supportedEndpoints : []
  if (endpoints.length > 0) {
    if (endpoints.includes('/chat/completions')) return 'openai'
    if (endpoints.includes('/responses')) return 'responses'
    if (endpoints.includes('/messages')) return 'anthropic'
    return undefined
  }
  const id = String(model?.id ?? '')
  if (catalogEntry?.vendor === 'Anthropic' || id.startsWith('claude')) return 'anthropic'
  return 'openai'
}

/**
 * Parse the live `/provider/v1/models` body.
 *
 * @param payload - parsed JSON.
 * @returns one normalized entry per model, in vendor order.
 * @throws {TypeError} when the body is not the documented `{ data: [...] }`.
 */
export function parseModelListPayload(payload) {
  const list = payload?.data
  if (!Array.isArray(list)) {
    throw new TypeError('unexpected /provider/v1/models response: expected { data: [...] }')
  }
  const seen = new Set()
  const models = []
  for (const raw of list) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const contextWindow = Number(raw.context_length ?? raw.contextWindow)
    models.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id,
      ...Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {},
      ...Array.isArray(raw.supported_endpoints)
        ? { supportedEndpoints: raw.supported_endpoints.filter((endpoint) => typeof endpoint === 'string') }
        : {},
    })
  }
  return models
}

/** Fetch and parse the live model list. */
export async function fetchModelList(url, signal) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) })
  if (!response.ok) throw new Error(`fetch ${url} failed: HTTP ${response.status} ${response.statusText}`)
  return parseModelListPayload(await response.json())
}

/**
 * Extract the capability catalog from the GOAT plan page.
 *
 * The page is a Next.js App Router document, so its data arrives as a stream
 * of `self.__next_f.push([1,"…"])` chunks whose payloads are JSON-escaped
 * fragments of one long string. Concatenating the unescaped fragments yields
 * the serialized RSC payload, inside which the catalog is a top-level array
 * beginning `[{"slug":`. The slice is then read with a string-aware bracket
 * scan — a naive `lastIndexOf(']')` would run past the array into whatever the
 * page carries next — and `"$undefined"` placeholders become `null` so the
 * result is valid JSON.
 *
 * @param html - the raw page body.
 * @returns the catalog entries as published.
 * @throws {Error} when the page carries no recognizable payload.
 */
export function parseCatalogPayload(html) {
  const text = String(html ?? '')
  const chunks = []
  for (const match of text.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    chunks.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
  }
  if (chunks.length === 0) throw new Error('no RSC payload found in the plan page')

  const joined = chunks.join('')
  const start = joined.indexOf('[{"slug":')
  if (start < 0) throw new Error('the plan page carries no model catalog array')

  let depth = 0
  let index = start
  let inString = false
  let escaped = false
  for (; index < joined.length; index += 1) {
    const char = joined[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) break
    }
  }
  if (depth !== 0) throw new Error('the plan page catalog array is unterminated')

  const json = joined.slice(start, index + 1).replace(/"\$undefined"/g, 'null')
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(`the plan page catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error('the plan page catalog is not an array')
  return parsed
}

/** Fetch and parse the capability catalog. */
export async function fetchCatalog(url, signal) {
  const response = await fetch(url, { headers: { accept: 'text/html' }, ...(signal ? { signal } : {}) })
  if (!response.ok) throw new Error(`fetch ${url} failed: HTTP ${response.status} ${response.statusText}`)
  return parseCatalogPayload(await response.text())
}

/** Index the catalog by both published id and slug. */
function indexCatalog(catalog) {
  const byId = new Map()
  const bySlug = new Map()
  const byName = new Map()
  const add = (map, key, entry) => {
    if (!map.has(key)) map.set(key, entry)
    else if (JSON.stringify(map.get(key)) !== JSON.stringify(entry)) map.set(key, null)
  }
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.id === 'string' && entry.id !== '') add(byId, entry.id, entry)
    if (typeof entry.slug === 'string' && entry.slug !== '') {
      const slug = slugify(entry.slug)
      add(bySlug, slug, entry)
    }
    if (typeof entry.name === 'string' && entry.name !== '') add(byName, entry.name, entry)
  }
  return { byId, bySlug, byName }
}

/**
 * Find the catalog entry describing one live model: exact id, then the id's
 * slug form against the published slug, then the display name — the vendor
 * renames ids between releases, so a strict id join keeps working only until
 * the next rename.
 */
function matchCatalogEntry(index, model) {
  for (const [map, key] of [[index.byId, model.id], [index.bySlug, slugify(model.id)], [index.byName, model.name]]) {
    if (map.has(key)) return map.get(key)
  }
}

/** Whether a catalog entry sits inside the selected tier. */
function withinPlan(entry, plan) {
  if (entry === undefined) return { included: true, reason: 'unindexed' }
  if (plan === 'max') return { included: true, reason: 'tier' }
  // An unknown tier has no floor to compare against. `normalizeConfig` pins the
  // plan to `PLANS`, so this is only reachable for a programmatic caller — but
  // `PLAN_MIN[plan]` being absent used to fall through to `min.has(...)` and
  // throw a TypeError, which is a worse answer than "publish everything".
  const min = PLAN_MIN[plan]
  if (min === undefined || min === null) return { included: true, reason: 'tier' }
  const minPlanName = entry.minPlanName
  if (typeof minPlanName !== 'string' || minPlanName === '') return { included: true, reason: 'unindexed' }
  if (!KNOWN_MIN_PLANS.has(minPlanName)) return { included: false, reason: 'unknown-tier' }
  return { included: min.has(minPlanName), reason: 'tier' }
}

/**
 * The capability fields one model contributes to `llm-pi-ai`.
 *
 * Only what the sources actually state is written. `llm-pi-ai` treats an
 * absent `input` as "text" and an absent `reasoningEfforts` as "keep the
 * installed catalog's answer", so an unenriched model stays honestly
 * under-claimed instead of gaining invented capabilities.
 */
function capabilities(entry, effortLevels) {
  const fields = {}
  if (entry === undefined) return { input: ['text'] }

  // The catalog carries `vision` / `reasoning` as flat fields and the same two
  // answers again inside `caps`. They agree in the published data; the flat
  // field is the one the plan tables are generated from, so it wins when a
  // future revision lets them drift, and `caps` is the fallback.
  //
  // The reader is deliberately tri-state. `caps?.[nested] === true` can only
  // ever answer `true` or `false`, so collapsing an entry that states *neither*
  // into `false` claimed "this model cannot think" on the vendor's behalf — and
  // an explicit `reasoningEfforts: false` is exactly that claim to `llm-pi-ai`,
  // which otherwise keeps whatever its installed catalog says. `undefined`
  // means "nobody said", and nothing is written for it.
  const stated = (flat, nested) => {
    if (typeof entry[flat] === 'boolean') return entry[flat]
    return typeof entry.caps?.[nested] === 'boolean' ? entry.caps[nested] : undefined
  }
  const vision = stated('vision', 'vision') === true
  const reasoning = stated('reasoning', 'reasoning')
  fields.input = vision ? ['text', 'image'] : ['text']

  if (reasoning === false) {
    // The vendor states the model cannot think; blocking the parameter is the
    // only way to stop the harness sending one the gateway would reject.
    fields.reasoningEfforts = false
  } else if (reasoning === true) {
    // The ladder is per model, and the gateway cannot be asked for it: it
    // answers 200 to every level it recognizes and clamps the ones the model
    // does not have. The reference the official CLI ships states it, so that
    // table decides — an id the table does not know keeps the old convention
    // rather than gaining levels nobody confirmed.
    const levels = effortLevels?.[entry.id] ?? BUNDLED_EFFORTS[entry.id]
    if (Array.isArray(levels)) {
      // An empty list is the reference's "—": the model exposes no effort
      // control at all. Omitting the field says exactly that; declaring `false`
      // would claim it cannot think, which is a different fact.
      if (levels.length > 0) fields.reasoningEfforts = effortMap(levels)
    } else {
      fields.reasoningEfforts = { off: null, medium: 'medium' }
    }
  }
  return fields
}

/**
 * The vendor's own label for a model's current deal, or `undefined`.
 *
 * The plan page states a `deal` object for the models that are on one — a
 * structured fact, not a guess from the price: `{ label: "Free", free: true,
 * discountPercent: 100, term: "while the stealth preview lasts", href, note }`.
 * Four to five entries carry a free deal at any time, and a few more carry a
 * partial one (`50% off`, `99% off`). Zero-cost-with-no-deal does not occur, so
 * this field is the whole signal.
 *
 * The label is passed through verbatim for two reasons: it is already written
 * for a reader, and it is the only wording that covers the partial discounts
 * without this module inventing a phrase ("99% off" is not "free", and calling
 * it that would be a claim the vendor did not make). `free` is kept separately
 * for the count, which only claims what the boolean states.
 */
export function dealLabel(entry) {
  const deal = entry?.deal
  if (deal === null || typeof deal !== 'object') return undefined
  const label = typeof deal.label === 'string' ? deal.label.trim() : ''
  if (label !== '') return label
  return deal.free === true ? 'Free' : undefined
}

/** Whether the vendor states this model is currently billed at $0. */
export function isFreeModel(entry) {
  return entry?.deal?.free === true
}

/**
 * Build the `llm-pi-ai` model entries for one tier.
 *
 * @param request - `{ apiList, catalog, plan, extraIds, effortLevels,
 *   maxContextWindow }`. `effortLevels` is the per-model effort reference
 *   (model id → levels); `maxContextWindow` caps the window written onto every
 *   model, and `0` keeps the vendor's own number.
 * @returns `{ routes, diagnostics, channels }` — `routes` holds one sorted,
 *   possibly empty array per route slot; `channels` states, per slot, which
 *   endpoint it speaks and how many live models advertise it versus how many
 *   were actually assigned (an empty channel with `advertised > 0` is the one a
 *   reader cannot explain without help); `diagnostics` lists what the sync could
 *   not state about the list it just wrote, for the caller to surface.
 */
export function buildEntries({
  apiList,
  catalog,
  plan = 'goat',
  extraIds = [],
  effortLevels = BUNDLED_EFFORTS,
  maxContextWindow = 0,
}) {
  if (!Number.isSafeInteger(maxContextWindow) || maxContextWindow < 0) throw new TypeError('maxContextWindow must be a non-negative integer')
  const index = indexCatalog(catalog)
  const routes = { openai: [], anthropic: [], responses: [] }
  const diagnostics = []
  let excluded = 0
  let unindexed = 0
  let unknownTier = 0

  for (const model of Array.isArray(apiList) ? apiList : []) {
    if (model === null || typeof model !== 'object' || typeof model.id !== 'string' || model.id === '') continue
    const entry = matchCatalogEntry(index, model)
    if (entry === null) { diagnostics.push(`${model.id}: ambiguous capability catalog match; model was not published`); continue }
    const gate = withinPlan(entry, plan)
    if (!gate.included) {
      excluded += 1
      if (gate.reason === 'unknown-tier') unknownTier += 1
      continue
    }
    if (gate.reason === 'unindexed') unindexed += 1

    const route = routeForModel(model, entry)
    if (route === undefined) {
      diagnostics.push(`${model.id}: unsupported advertised endpoints; model was not published`)
      continue
    }
    const item = { id: model.id }
    // A model on a deal says so in the name, because the name is the only thing
    // a model picker shows: the harness lists one line per model and the reader
    // chooses from that line. Free models cost no quota, which is exactly the
    // fact a reader cannot see at the moment they are choosing.
    const deal = dealLabel(entry)
    const base = entry?.name ?? model.name
    const name = typeof base === 'string' && base !== '' && deal !== undefined ? `${base} · ${deal}` : base
    if (typeof name === 'string' && name !== '' && name !== model.id) item.name = name
    const contextWindow = model.contextWindow ?? entry?.contextWindow
    if (Number.isSafeInteger(contextWindow) && contextWindow > 0) {
      // The vendor states what the *model* can take; this route is what has to
      // serve it, and a gateway can refuse well below the model's own ceiling.
      // DSH compacts at a fraction of this number, so over-claiming it does not
      // buy a longer conversation — it buys a hard failure once the request
      // passes what the route really accepts, instead of a summary.
      const capped = maxContextWindow > 0 ? Math.min(contextWindow, maxContextWindow) : contextWindow
      item.contextWindow = capped
    }
    Object.assign(item, capabilities(entry, effortLevels))
    routes[route].push(item)
  }

  // Private ids outside the published catalog always belong on the OpenAI-shaped
  // route: they are the user's own deployment detail, and nothing can route
  // them by capability because nothing describes them.
  const known = new Set((Array.isArray(apiList) ? apiList : []).map((model) => model?.id))
  for (const raw of Array.isArray(extraIds) ? extraIds : []) {
    const id = String(raw ?? '').trim()
    if (id === '' || known.has(id)) continue
    known.add(id)
    routes.openai.push({ id, input: ['text'], ...maxContextWindow > 0 ? { contextWindow: maxContextWindow } : {} })
  }

  for (const route of ROUTE_ORDER) routes[route].sort((left, right) => left.id.localeCompare(right.id))

  // Why a channel can be empty is a fact about the upstream list, and it is the
  // question the reader actually has when a provider does not appear: "the
  // vendor serves nothing on this protocol" and "the vendor serves plenty, but
  // every one of them prefers another channel" look identical in a route that
  // was simply never created. Both numbers are stated, so the card can say
  // which one it is.
  const channels = {}
  for (const route of ROUTE_ORDER) {
    const endpoint = ROUTES[route].endpoint
    let advertised = 0
    for (const model of Array.isArray(apiList) ? apiList : []) {
      if (Array.isArray(model?.supportedEndpoints) && model.supportedEndpoints.includes(endpoint)) advertised += 1
    }
    channels[route] = { endpoint, advertised, assigned: routes[route].length }
  }

  if (!Array.isArray(catalog) || catalog.length === 0) {
    diagnostics.push('capability catalog unavailable: reasoning and vision are unstated, and every model is treated as inside the selected tier')
  } else {
    if (unindexed > 0) diagnostics.push(`${unindexed} model(s) are not in the capability catalog: capabilities unstated and tier unchecked`)
    if (unknownTier > 0) diagnostics.push(`${unknownTier} model(s) name a subscription tier this build does not know, so they were left out of ${plan}`)
  }
  if (excluded > 0) diagnostics.push(`${excluded} model(s) sit above the ${PLAN_TITLES[plan] ?? plan} tier and were left out`)

  return { routes, diagnostics, channels }
}

/**
 * How many models each tier admits, from the capability catalog alone.
 *
 * The tiers are cumulative, so the answer is one running sum rather than four
 * independent counts: a model whose `minPlanName` is `Pro` is in Pro and Max
 * and not in Go or GOAT.
 *
 * @param catalog - the parsed plan-page catalog.
 * @returns `{ go, goat, pro, max }`, or `undefined` for a catalog that carries
 *   no tier information at all — the counts would be fabricated, and a card
 *   showing `0` beside Go reads as "Go grants nothing" rather than "unknown".
 */
export function tierCounts(catalog) {
  const entries = Array.isArray(catalog) ? catalog : []
  if (entries.length === 0) return undefined
  let go = 0
  let goat = 0
  let pro = 0
  let max = 0
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const min = typeof entry.minPlanName === 'string' ? entry.minPlanName : ''
    if (!KNOWN_MIN_PLANS.has(min)) {
      // A tier this build has never heard of is above everything it knows, the
      // same way `max` treats it — so it counts towards the top tier only.
      max += 1
    } else if (min === 'Go') go += 1
    else if (min === 'GOAT') goat += 1
    else if (min === 'Pro') pro += 1
    else max += 1
  }
  return { go, goat: go + goat, pro: go + goat + pro, max: go + goat + pro + max }
}

/**
 * Count what the catalog offers per tier, without needing the live list — what
 * the settings card shows when explaining what a tier would select.
 */
export function planCatalogSummary(catalog, plan) {
  return tierCounts(catalog)?.[plan] ?? 0
}

/**
 * How many models each tier grants right now, from both sources.
 *
 * Two different questions, which is why there are two numbers. `models` is what
 * the vendor's catalog entitles the tier to; `live` is how many of those the
 * models endpoint is actually serving today, because a model can be announced
 * on the plan page before it appears on the endpoint (and vice versa). A tier
 * whose live number is lower than its catalog number is not broken — it is a
 * tier whose newest models have not shipped yet.
 *
 * Both are `null` when the source that answers them has not been read. A zero
 * there would be a claim, and "0 models" beside a tier is a claim that is
 * usually false.
 *
 * @param request - `{ apiList, catalog }`, either possibly empty.
 * @returns one `{ plan, models, live, free }` row per tier, cheapest first.
 *   `free` counts the models the endpoint is serving that the vendor states are
 *   billed at $0 — the same "right now" basis as `live`, so the two numbers are
 *   read against each other rather than against the plan page.
 */
export function tierAvailability({ apiList, catalog } = {}) {
  const entries = Array.isArray(catalog) ? catalog : []
  const models = Array.isArray(apiList) ? apiList : []
  const counts = tierCounts(entries)
  const index = indexCatalog(entries)
  const live = { go: 0, goat: 0, pro: 0, max: 0 }
  const free = { go: 0, goat: 0, pro: 0, max: 0 }

  for (const model of models) {
    if (model === null || typeof model !== 'object' || typeof model.id !== 'string') continue
    const entry = matchCatalogEntry(index, model)
    if (entry === null) continue
    const isFree = isFreeModel(entry)
    for (const plan of PLANS) {
      if (!withinPlan(entry, plan).included) continue
      live[plan] += 1
      if (isFree) free[plan] += 1
    }
  }

  return PLANS.map((plan) => ({
    plan,
    models: counts === undefined ? null : counts[plan],
    live: models.length === 0 ? null : live[plan],
    free: models.length === 0 ? null : free[plan],
  }))
}
