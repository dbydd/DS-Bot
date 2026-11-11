import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Write', instructions: '', createdAt: 2 },
  },
  rooms: { room: { id: 'room', name: 'Desk', members: ['chief', 'writer'], sessions: { writer: 'room-writer' }, admin: 'chief', mode: 'everyone' } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})

async function setup({ relay } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-relay-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const sent = []
  const ctx = fakeContext({ services: relay === undefined ? {} : { botRelay: relay } })
  const agents = new Map()
  const created = agent => Promise.all((ctx.listeners.get('agent/created') ?? []).map(listener => listener({ agent })))
  const agentFor = async (id) => {
    if (agents.has(id)) return agents.get(id)
    const agent = {
      id,
      session: { id },
      ctx: { tools: { register: () => () => {}, restrict: () => () => {} }, on: () => () => {}, effect: execute => execute() },
      followup: message => sent.push({ sessionId: id, message }),
      steer: message => sent.push({ sessionId: id, message, steer: true }),
    }
    agents.set(id, agent)
    await created(agent)
    return agent
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 'new' }), resolveAgent: async id => ({ agent: await agentFor(id) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  apply(ctx, { home, github: false, diagnosticsFile: false })
  const dsBot = ctx.get('dsBot')
  await dsBot.rt.load()
  return {
    ctx,
    dsBot,
    sent,
    stop: async () => {
      await ctx.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

const guard = (ctx, name, sessionId = 'chief') => ctx.guards
  .map(check => check({ name, agent: { id: sessionId }, arguments: {} }))
  .find(reason => reason !== undefined)

test('a direct Bot-to-Bot message goes over the Onlyne relay when one is mounted', async () => {
  const calls = []
  const relay = { relay: async (message) => { calls.push(message) } }
  const { dsBot, sent, stop } = await setup({ relay })
  try {
    const id = await dsBot.rt.deliver({ fromId: 'chief', toId: 'writer', text: 'Draft it', role: 'request' })
    assert.equal(calls.length, 1)
    assert.equal(sent.length, 0)
    assert.equal(calls[0].fromSessionId, 'chief')
    assert.equal(calls[0].toSessionId, 'writer')
    assert.equal(calls[0].deliveryKind, 'request')
    assert.equal(calls[0].header, '[Message from Chief]')
    assert.equal(calls[0].text, 'Draft it')
    assert.equal(calls[0].source.exchangeId, id)
    assert.equal(calls[0].source.abandoned, undefined)
    assert.equal(dsBot.rt.state.exchanges.length, 1)
    assert.equal(dsBot.rt.state.exchanges[0].id, id)
  } finally {
    await stop()
  }
})

test('a relay that is not up yet falls back to the local session', async () => {
  const relay = { relay: async () => { throw new Error('node down') } }
  const { dsBot, sent, stop } = await setup({ relay })
  try {
    await dsBot.rt.deliver({ fromId: 'chief', toId: 'writer', text: 'Still here', role: 'request' })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].sessionId, 'writer')
    assert.match(sent[0].message.content[0].text, /^\[Message from Chief]\nStill here$/)
    assert.equal(dsBot.rt.state.exchanges.length, 1)
  } finally {
    await stop()
  }
})

test('group turns, named sessions, and attachments stay on the local path', async () => {
  const calls = []
  const relay = { relay: async (message) => { calls.push(message) } }
  const { dsBot, sent, stop } = await setup({ relay })
  try {
    await dsBot.rt.deliver({ fromId: 'chief', toId: 'writer', roomId: 'room', text: 'In the group', role: 'room' })
    await dsBot.rt.deliver({ fromId: 'chief', toId: 'writer', sessionId: 'room-writer', text: 'Named session', role: 'request' })
    await dsBot.rt.deliver({ fromId: 'chief', toId: 'writer', text: 'With a file', role: 'request', files: [{ name: 'note.txt' }] })
    assert.equal(calls.length, 0)
    assert.equal(sent.length, 3)
  } finally {
    await stop()
  }
})

test('the relay keeps the 0.3.2 delivery flags', async () => {
  const calls = []
  const relay = { relay: async (message) => { calls.push(message) } }
  const { dsBot, sent, stop } = await setup({ relay })
  try {
    await dsBot.rt.deliver({
      fromId: 'chief', fromName: 'Alias', toId: 'writer', text: 'Give up', role: 'request', abandoned: true, recordExchange: false,
    })
    assert.equal(calls.length, 1)
    assert.equal(sent.length, 0)
    assert.match(calls[0].header, /Waiting given up · Alias/)
    assert.equal(calls[0].source.abandoned, true)
    assert.equal(calls[0].source.senderName, 'Alias')
    assert.equal(dsBot.rt.state.exchanges.length, 0)
  } finally {
    await stop()
  }
})

test('dsBot publishes tools and can lift a hidden one', async () => {
  const { ctx, dsBot, stop } = await setup()
  try {
    assert.equal(typeof dsBot.registerTool, 'function')
    const remove = dsBot.registerTool({ name: 'omd_ping', description: 'ping', parameters: {}, async execute() { return 'pong' } })
    assert.equal(dsBot.isAllowed('omd_ping', 'chief'), true)
    assert.equal(dsBot.rt.teamTools.some(tool => tool.name === 'omd_ping'), true)
    remove()
    assert.equal(dsBot.isAllowed('omd_ping'), false)
    assert.equal(dsBot.rt.teamTools.some(tool => tool.name === 'omd_ping'), false)
    assert.match(guard(ctx, 'subagent'), /subagents/)
    const lift = dsBot.allowTool('subagent')
    assert.equal(guard(ctx, 'subagent'), undefined)
    lift()
    assert.match(guard(ctx, 'subagent'), /subagents/)
  } finally {
    await stop()
  }
})
