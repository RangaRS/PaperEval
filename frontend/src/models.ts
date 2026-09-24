import type { ModelInfo } from './api'

export interface ModelGroups {
  /** Models the server says can read images. */
  vision: ModelInfo[]
  /** Models the server says nothing about. */
  unknown: ModelInfo[]
  /** Models added by name that the lists above do not already show. */
  added: string[]
}

/**
 * The models to offer. Models the server says cannot read images are left out,
 * unless they were added by name.
 */
export function modelGroups(models: ModelInfo[], added: string[]): ModelGroups {
  const vision = models.filter((model) => model.vision === true)
  const unknown = models.filter((model) => model.vision === null)
  const shown = new Set([...vision, ...unknown].map((model) => model.name))
  const extra = added.map((name) => name.trim()).filter((name) => name !== '' && !shown.has(name))
  return { vision, unknown, added: [...new Set(extra)] }
}

export const offeredNames = (groups: ModelGroups): string[] => [
  ...groups.vision.map((model) => model.name),
  ...groups.unknown.map((model) => model.name),
  ...groups.added,
]

/**
 * The model to use: the one picked earlier if it is still offered, else the
 * configured default, else the first vision model. While the server's list is
 * unknown (for example when it cannot be reached), the earlier pick is kept.
 */
export function chooseModel(saved: string, configured: string, groups: ModelGroups, listKnown: boolean): string {
  const offered = offeredNames(groups)
  const available = (name: string) => name !== '' && (!listKnown || offered.includes(name))
  if (available(saved)) return saved
  if (available(configured)) return configured
  return offered[0] ?? ''
}
