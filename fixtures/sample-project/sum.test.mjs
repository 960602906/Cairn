import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sum } from './sum.mjs'

test('sum adds every number', () => {
  assert.equal(sum([1, 2, 3]), 6)
  assert.equal(sum([10]), 10)
})

test('sum of no numbers is 0', () => {
  assert.equal(sum([]), 0)
})
