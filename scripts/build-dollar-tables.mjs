/**
 * Refresh `lib/dollar-equivalents.js` from the official plan pages.
 *
 * The plugin shows what a plan's monthly credits are worth in dollars on the
 * vendor's own model table. The table changes whenever the vendor reprices a
 * model, so the shipped copy carries the date it was captured and this script
 * exists to recapture it: `node scripts/build-dollar-tables.mjs` rewrites the
 * data block and stamps a fresh capture date.
 */
import { writeFile } from 'node:fs/promises'

const BASE = 'https://commandcode.ai/docs/plans/'
const PAGES = ['go', 'goat', 'pro', 'max']

/** Parse every table on one plan page as arrays of cell strings. */
async function tablesOf(plan) {
  const html = await fetch(`${BASE}${plan}`).then((response) => {
    if (!response.ok) throw new Error(`${plan}: HTTP ${response.status}`)
    return response.text()
  })
  const tables = []
  for (const block of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const rows = []
    for (const tr of block[0].matchAll(/<tr[\s\S]*?<\/tr>/g)) {
      const cells = [...tr[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
        .map((cell) => cell[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      if (cells.length > 0) rows.push(cells)
    }
    if (rows.length > 1) tables.push(rows)
  }
  return tables
}

/** `$100` / `Free` → a number; anything else is not a dollar figure. */
const dollars = (cell) => {
  const text = String(cell ?? '')
  if (/free/i.test(text)) return 0
  const value = Number(text.replace(/[^0-9.]/g, ''))
  return Number.isFinite(value) ? value : undefined
}

/** `{ key: { page, pool, values } }` for every table the pages publish. */
const tables = {}
for (const plan of PAGES) {
  for (const rows of await tablesOf(plan)) {
    const header = rows[0]
    const joined = header.join(' | ')
    if (/Max 10× credits/.test(joined)) {
      // The Max page states both sizes in one table, one dollar column each.
      for (const [key, column, pool] of [['max-10x', 5, 150], ['max-20x', 6, 300]]) {
        const values = {}
        for (const row of rows.slice(1)) {
          const value = dollars(row[column])
          if (value !== undefined && row[0]) values[row[0]] = value
        }
        tables[key] = { page: plan, pool, values }
      }
    } else if (/Monthly credits/.test(joined)) {
      const pool = { go: 10, goat: 70, pro: 80 }[plan]
      if (pool === undefined) continue
      // One page publishes several of these tables — one per model group —
      // and the range is only right once every group has been merged in.
      const target = tables[plan] ?? { page: plan, pool, values: {} }
      for (const row of rows.slice(1)) {
        const value = dollars(row[5])
        if (value !== undefined && row[0] && target.values[row[0]] === undefined) target.values[row[0]] = value
      }
      tables[plan] = target
    }
  }
}

for (const plan of ['go', 'goat', 'pro', 'max-10x', 'max-20x']) {
  if (!tables[plan]) throw new Error(`no dollar table captured for ${plan}`)
}

const capturedAt = new Date().toISOString().slice(0, 10)
const emit = (value, indent) => {
  if (Array.isArray(value)) return `[${value.map((item) => emit(item, indent)).join(', ')}]`
  if (value !== null && typeof value === 'object') {
    const pad = ' '.repeat(indent)
    const inner = ' '.repeat(indent + 2)
    const entries = Object.entries(value).map(([key, item]) => `${inner}${JSON.stringify(key)}: ${emit(item, indent + 2)}`)
    return `{\n${entries.join(',\n')}\n${pad}}`
  }
  return JSON.stringify(value)
}

const header = `/**
 * The vendor's per-model dollar value of a plan's monthly credits.
 *
 * Every figure here is quoted from the official plan pages, not derived: the
 * GOAT page publishes a "Monthly credits" column that says what the plan's
 * credits are worth on each model (\`$100\` on DeepSeek V4.1 Flash, \`$70\` on
 * GLM-5.2), and the Max page publishes one column per size. Those dollar
 * figures move whenever the vendor reprices a model, so the block below is a
 * capture with a date rather than a live reading — \`capturedAt\` is when this
 * build scraped the pages, and the card prints it beside every converted
 * figure so a reader can judge how fresh the number is.
 *
 * Refresh with \`node scripts/build-dollar-tables.mjs\`.
 */

/** When the tables below were captured (UTC date). */
export const CAPTURED_AT = ${JSON.stringify(capturedAt)}

/** The plan pages the tables were read from. */
export const SOURCE_BASE = ${JSON.stringify(BASE)}

const TABLES = ${emit(tables, 0)}

/**
 * The dollar figures for one plan size, or null when this build has no table
 * for it — an unknown plan is not a number to guess at.
 *
 * @param plan - the plan id (\`go\`, \`goat\`, \`pro\`, \`max\`).
 * @param variant - the size as the card states it; Max is sold as two, each
 *   with its own column on the vendor's page, so \`monthly\` picks the column.
 * @returns \`{ capturedAt, source, pool, min, max }\`: what the plan's whole
 *   monthly pool is worth across the vendor's table — the cheapest model it
 *   can be spent on and the dearest — plus the pool those dollars describe.
 */
export function planDollar(plan, variant) {
  const key = plan === 'max'
    ? (Number(variant?.monthly) >= 300 ? 'max-20x' : 'max-10x')
    : plan
  const table = TABLES[key]
  if (!table) return null
  // Free models publish $0 because credits are not needed to use them; they
  // would drag the floor to zero and turn "worth $100–$150" into a range that
  // reads as "possibly nothing".
  const positive = Object.values(table.values).filter((value) => value > 0)
  if (positive.length === 0) return null
  return {
    capturedAt: CAPTURED_AT,
    source: \`\${SOURCE_BASE}\${table.page}\`,
    pool: table.pool,
    min: Math.min(...positive),
    max: Math.max(...positive),
  }
}

/**
 * What some credits are worth on the same table, as a range.
 *
 * The table prices a whole monthly pool, so any other amount scales against
 * it: half the pool is worth half the range. The vendor's own per-model
 * figures are the endpoints, because which model the credits land on is the
 * reader's choice and the plugin does not know it.
 *
 * @param dollar - a {@link planDollar} result, or null/undefined.
 * @param credits - the credit amount to convert.
 * @returns \`{ min, max }\` in dollars, or null when there is no table.
 */
export function dollarRange(dollar, credits) {
  const amount = Number(credits)
  if (!dollar || !Number.isFinite(amount) || dollar.pool <= 0) return null
  return {
    min: amount * dollar.min / dollar.pool,
    max: amount * dollar.max / dollar.pool,
  }
}

/**
 * The table for one usage report: the account's own plan when the report
 * states one, otherwise the tier this plugin writes. A report does not say
 * which Max size the account is on, so the first (10×) stands — the range it
 * produces is the conservative one.
 *
 * @param report - a usage report, or anything without a subscription.
 * @param configuredPlan - the tier the plugin is configured to write.
 * @returns a {@link planDollar} result, or null when neither plan is known.
 */
export function reportDollar(report, configuredPlan) {
  const plan = typeof report?.subscription?.plan === 'string' && report.subscription.plan !== ''
    ? report.subscription.plan
    : configuredPlan
  return planDollar(plan)
}
`

await writeFile('lib/dollar-equivalents.js', header)
const counts = Object.fromEntries(Object.entries(tables).map(([key, table]) => [key, Object.keys(table.values).length]))
console.log(`wrote lib/dollar-equivalents.js (captured ${capturedAt})`, counts)
