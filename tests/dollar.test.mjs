import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CAPTURED_AT, SOURCE_BASE, dollarRange, planDollar, reportDollar } from '../lib/dollar-equivalents.js'

/**
 * The shipped dollar tables are a capture of the vendor's pages, so these
 * tests pin the invariants a reader depends on rather than the figures
 * themselves: a recapture legitimately moves the numbers, and must not turn
 * the suite red for it.
 */
describe('dollar equivalents', () => {
  it('quotes a positive, ordered range for every plan the pages publish', () => {
    for (const [plan, pool] of [['go', 10], ['goat', 70], ['pro', 80]]) {
      const dollar = planDollar(plan, { monthly: pool })
      assert.ok(dollar, `${plan} has a table`)
      assert.equal(dollar.pool, pool)
      assert.ok(dollar.min > 0, `${plan} floor is a real price, not a free model`)
      assert.ok(dollar.max >= dollar.min, `${plan} range is ordered`)
      assert.equal(dollar.capturedAt, CAPTURED_AT)
      assert.equal(dollar.source, `${SOURCE_BASE}${plan}`)
    }
  })

  it('prices the two Max sizes from their own columns of the table', () => {
    const small = planDollar('max', { monthly: 150 })
    const large = planDollar('max', { monthly: 300 })
    assert.equal(small.pool, 150)
    assert.equal(large.pool, 300)
    assert.ok(small.max <= large.max, 'twice the credits are never worth less')
    // A report that does not name a size (the usage tool never does) stands
    // for the first size, which is the conservative end of the range.
    assert.equal(planDollar('max').pool, 150)
    assert.equal(planDollar('max', { monthly: 300 }).pool, 300)
  })

  it('answers nothing for a plan this build has no table for', () => {
    assert.equal(planDollar('enterprise'), null)
    assert.equal(planDollar(undefined), null)
  })

  it('scales a whole pool to the table, and half a pool to half of it', () => {
    const dollar = planDollar('goat')
    assert.deepEqual(dollarRange(dollar, dollar.pool), { min: dollar.min, max: dollar.max })
    const half = dollarRange(dollar, dollar.pool / 2)
    assert.equal(half.min, dollar.min / 2)
    assert.equal(half.max, dollar.max / 2)
    // Nothing to quote is not a number to invent.
    assert.equal(dollarRange(null, 10), null)
    assert.equal(dollarRange(dollar, Number.NaN), null)
    assert.equal(dollarRange({ min: 1, max: 2, pool: 0 }, 10), null)
  })

  it('prefers the plan the account states over the tier the plugin writes', () => {
    assert.equal(reportDollar({ subscription: { plan: 'pro' } }, 'goat').pool, 80)
    assert.equal(reportDollar({}, 'goat').pool, 70)
    assert.equal(reportDollar({ subscription: { plan: '' } }, 'goat').pool, 70)
    assert.equal(reportDollar(undefined, undefined), null)
  })

  it('stamps a capture date a reader can hold against a calendar', () => {
    assert.match(CAPTURED_AT, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(Date.parse(CAPTURED_AT) > 0, 'an ISO date the reader can parse')
    assert.match(SOURCE_BASE, /^https:\/\//)
  })
})
