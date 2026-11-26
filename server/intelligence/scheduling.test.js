import test from 'node:test'
import assert from 'node:assert/strict'
import { createScheduleOccurrences, parseScheduleIntent } from './scheduling.js'

test('one-week post request asks for cadence and time instead of guessing', () => {
  const intent = parseScheduleIntent('Post about Biz for one week')
  assert.equal(intent.mode, 'recurring')
  assert.equal(intent.clarificationQuestion, 'How many posts per week, and what time each day? Example: 1 per day at 9am, or 3 posts total?')
})

test('next week without cadence asks before drafting or scheduling', () => {
  const intent = parseScheduleIntent('Post about Biz next week')
  assert.equal(intent.mode, 'recurring')
  assert.equal(intent.clarificationQuestion, 'How many posts per week, and what time each day? Example: 1 per day at 9am, or 3 posts total?')
})

test('posting now is explicitly immediate and needs no schedule clarification', () => {
  assert.deepEqual(parseScheduleIntent('Post only now about Biz'), { mode: 'now', timezone: 'UTC' })
})

test('daily series without content choice asks one question after parsing its times', () => {
  const intent = parseScheduleIntent('Post every day at 9am for 7 days', { timezone: 'America/Los_Angeles' })
  assert.equal(intent.count, 7)
  assert.equal(intent.time, '09:00')
  assert.equal(intent.timezone, 'America/Los_Angeles')
  assert.equal(intent.clarificationQuestion, 'Should I use the same text 7 times, or make 7 different versions?')
})

test('tomorrow schedule resolves a local time into the requested timezone', () => {
  const intent = parseScheduleIntent('Schedule a LinkedIn post for tomorrow 10am', {
    timezone: 'America/Los_Angeles',
    now: new Date('2026-03-09T12:00:00.000Z'),
  })
  assert.equal(intent.mode, 'scheduled')
  assert.equal(intent.timezone, 'America/Los_Angeles')
  assert.equal(intent.scheduledAt, '2026-03-10T17:00:00.000Z')
})

test('a time that has passed today asks whether to schedule tomorrow or post now', () => {
  const intent = parseScheduleIntent('Schedule a LinkedIn post today at 9am', {
    timezone: 'UTC',
    now: new Date('2026-03-09T12:00:00.000Z'),
  })
  assert.equal(intent.clarificationQuestion, 'That time has already passed today. Should I schedule it for tomorrow or post now?')
})

test('two-hour schedule resolves relative to the request time', () => {
  const intent = parseScheduleIntent('Post on LinkedIn in 2 hours', {
    now: new Date('2026-03-09T12:00:00.000Z'),
  })
  assert.equal(intent.scheduledAt, '2026-03-09T14:00:00.000Z')
})

test('daily scheduled posts preserve local clock time across daylight-saving changes', () => {
  const occurrences = createScheduleOccurrences({
    startAt: '2026-03-07T17:00:00.000Z',
    count: 3,
    intervalMinutes: 1440,
    timezone: 'America/Los_Angeles',
  })
  assert.deepEqual(occurrences, [
    '2026-03-07T17:00:00.000Z',
    '2026-03-08T16:00:00.000Z',
    '2026-03-09T16:00:00.000Z',
  ])
})
