import { createSource } from './sources.js'

/** Plugin tabs in the existing Bot and group details drawer. */
export const detailsTabs = createSource([])

/**
 * Add a tab through window.dshBot.registerDetailsTab.
 * @param {object} entry - Stable id, label string or function, React component, and optional order.
 * @returns {Function} Idempotent disposer for this registration.
 */
export function registerDetailsTab(entry) {
  const { id, label, component, order = 0 } = entry
  if (typeof id !== 'string' || !id || id === 'details' || id === 'browser') throw new Error('A details tab needs a unique plugin id')
  if (typeof label !== 'string' && typeof label !== 'function') throw new Error('A details tab needs a label')
  if (typeof component !== 'function') throw new Error('A details tab needs a React component')
  if (!Number.isFinite(order)) throw new Error('A details tab order must be finite')
  if (detailsTabs.getSnapshot().some(tab => tab.id === id)) throw new Error(`Details tab "${id}" is already registered`)
  const tab = { id, label, component, order }
  detailsTabs.set(tabs => [...tabs, tab].sort((left, right) => left.order - right.order))
  return () => detailsTabs.set(tabs => tabs.includes(tab) ? tabs.filter(value => value !== tab) : tabs)
}
