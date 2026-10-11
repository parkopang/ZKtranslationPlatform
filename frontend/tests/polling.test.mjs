import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { transformWithOxc } from 'vite'

const transformed = await transformWithOxc(readFileSync(new URL('../src/polling.ts', import.meta.url), 'utf8'), 'polling.ts', { lang: 'ts' })
const sandbox = { AbortController }
vm.runInNewContext(transformed.code.replace(/^export /gm, '') + '\nglobalThis.createPoller = createPoller;', sandbox)
const { createPoller } = sandbox
const settle = () => new Promise(setImmediate)
function environment() {
  let now = 0, serial = 0, visible = true, online = true, wake = () => {}, unsubscribed = false
  const timers = new Map()
  return {
    api: { visible: () => visible, online: () => online,
      setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id },
      clearTimer: (id) => timers.delete(id), subscribe: (callback) => { wake = callback; return () => { unsubscribed = true } } },
    advance: async (time) => { now += time; const due = [...timers.entries()].filter(([, timer]) => timer.at <= now); for (const [id, timer] of due) { timers.delete(id); timer.callback() }; await settle() },
    setVisible: (value) => { visible = value; wake() }, setOnline: (value) => { online = value; wake() }, wake: () => wake(),
    get timers() { return timers.size }, get unsubscribed() { return unsubscribed },
  }
}

test('empty or terminal snapshots continue polling every five seconds without overlap', async () => {
  const e = environment(); let reads = 0
  const poll = createPoller(async () => { reads += 1 }, e.api)
  await settle(); assert.equal(reads, 1); assert.equal(e.timers, 1)
  await e.advance(4999); assert.equal(reads, 1)
  await e.advance(1); assert.equal(reads, 2)
  await e.advance(5000); assert.equal(reads, 3)
  poll.stop(); assert.equal(e.timers, 0); assert.equal(e.unsubscribed, true)
})

test('focus and reconnect queue one fresh read and cannot commit a stale in-flight result', async () => {
  const e = environment(); let release; let reads = 0, concurrent = 0, maxConcurrent = 0; const applied = []
  const poll = createPoller(async (context) => {
    const read = ++reads; concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent)
    if (read === 1) await new Promise((resolve) => { release = resolve })
    if (context.isCurrent()) applied.push(read)
    concurrent -= 1
  }, e.api)
  e.wake(); e.wake(); e.wake(); assert.equal(reads, 1)
  release(); await settle()
  assert.equal(reads, 2); assert.equal(maxConcurrent, 1); assert.deepEqual(applied, [2]); poll.stop()
})

test('a write pause rejects old snapshots and refreshes only after the mutation completes', async () => {
  const e = environment(); let release; let reads = 0; const applied = []
  const poll = createPoller(async (context) => { const read = ++reads; if (read === 1) await new Promise((resolve) => { release = resolve }); if (context.isCurrent()) applied.push(read) }, e.api)
  poll.pause(); release(); await settle(); await e.advance(10000)
  assert.equal(reads, 1); assert.deepEqual(applied, [])
  poll.resume(); await settle(); assert.equal(reads, 2); assert.deepEqual(applied, [2]); poll.stop()
})

test('hidden and offline tabs stop polling, then visibility and online events recover immediately', async () => {
  const e = environment(); let reads = 0
  const poll = createPoller(async () => { reads += 1 }, e.api)
  await settle(); e.setVisible(false); await e.advance(30000); assert.equal(reads, 1)
  e.setVisible(true); await settle(); assert.equal(reads, 2)
  e.setOnline(false); await e.advance(30000); assert.equal(reads, 2)
  e.setOnline(true); await settle(); assert.equal(reads, 3)
  poll.stop(); e.wake(); await e.advance(30000); assert.equal(reads, 3)
})

test('failed reads use bounded retries rather than stopping or spinning', async () => {
  const e = environment(); let reads = 0
  const poll = createPoller(async () => { reads += 1; throw new Error('temporary network error') }, e.api)
  await settle(); assert.equal(reads, 1)
  await e.advance(5000); assert.equal(reads, 2); assert.equal(e.timers, 1); poll.stop()
})

test('explicit workspace role wins over the remembered role', async () => {
  const code = await transformWithOxc(readFileSync(new URL('../src/workspace.ts', import.meta.url), 'utf8'), 'workspace.ts', { lang: 'ts' })
  const context = { URLSearchParams }
  vm.runInNewContext(code.code.replace(/^export /gm, '') + '\nglobalThis.workspaceRole = workspaceRole;', context)
  assert.equal(context.workspaceRole('?workspace=admin', 'translator'), 'admin')
  assert.equal(context.workspaceRole('?workspace=translator&register=1', 'admin'), 'translator')
  assert.equal(context.workspaceRole('', 'admin'), 'admin')
  assert.equal(context.workspaceRole('', null), 'translator')
})
