import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detailsTabs, registerDetailsTab } from '../src/client/details-tabs.js'

test('plugin tabs publish in order and unload independently', () => {
  const component = () => null
  let updates = 0
  const unsubscribe = detailsTabs.subscribe(() => { updates += 1 })
  const later = registerDetailsTab({ id: 'later', label: 'Later', component, order: 5 })
  const earlier = registerDetailsTab({ id: 'earlier', label: 'Earlier', component, order: -1 })
  try {
    assert.deepEqual(detailsTabs.getSnapshot().map(tab => tab.id), ['earlier', 'later'])
    earlier()
    assert.deepEqual(detailsTabs.getSnapshot().map(tab => tab.id), ['later'])
    const settled = updates
    earlier()
    assert.equal(updates, settled)
    assert.throws(() => registerDetailsTab({ id: 'later', label: 'Duplicate', component }), /already registered/)
  } finally {
    earlier()
    later()
    unsubscribe()
  }
  assert.deepEqual(detailsTabs.getSnapshot(), [])
})

test('an unloaded plugin can reload under the same id', () => {
  const component = () => null
  const old = registerDetailsTab({ id: 'notes', label: 'Notes', component })
  old()
  const current = registerDetailsTab({ id: 'notes', label: 'Current notes', component })
  try {
    old()
    assert.equal(detailsTabs.getSnapshot()[0].label, 'Current notes')
  } finally {
    current()
  }
})

test('plugin ids cannot replace built-in tabs', () => {
  for (const id of ['details', 'browser']) {
    assert.throws(() => registerDetailsTab({ id, label: 'Replacement', component: () => null }), /unique plugin id/)
  }
})
