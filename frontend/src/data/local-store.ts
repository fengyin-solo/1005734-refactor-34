import {
  DEFECT_KEY,
  PATROL_KEY,
  PATROL_STATUS_REPORTED,
  createDefectsForPatrol,
  hasFinding,
  normalizePatrolRow,
  sortByPatrolDate,
  stampLegacyReport,
} from '@/domain/patrol-finding'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'substation-protection:entries'
// 存量巡视数据的回填版本号：升过一次就不再重跑，历史已上报结论随之锁死。
const BACKFILL_KEY = 'substation-protection:patrol-backfill-v1'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 存量回填（只跑一遍）：
 * 1. 巡视记录按巡视日期顺序（同日按编号）逐条归一：发现缺陷数回填为整数；
 *    未上报的处理情况换成统一写法，已上报的保留上报当时原文。
 * 2. 历史已上报记录补盖「上报当时结论」快照，之后三处判定都只认这份快照。
 * 3. 已上报且判「发现问题」的巡视，按缺陷数补建缺陷处置待办；
 *    同一巡视编号只补建一次，同一趟巡视不重复算。
 */
function migratePatrolFindings(
  data: Record<string, EntryRow[]>,
  alreadyBackfilled: boolean,
): Record<string, EntryRow[]> {
  if (alreadyBackfilled) {
    return data
  }
  const patrols = (data[PATROL_KEY] ?? []).map((row) => {
    const normalized = normalizePatrolRow(row)
    if (String(normalized.status) === PATROL_STATUS_REPORTED) {
      return stampLegacyReport(normalized)
    }
    return normalized
  })
  data[PATROL_KEY] = sortByPatrolDate(patrols)

  const defects = [...(data[DEFECT_KEY] ?? [])]
  let nextDefectId = defects.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  for (const patrol of sortByPatrolDate(patrols)) {
    if (String(patrol.status) !== PATROL_STATUS_REPORTED || !hasFinding(patrol)) {
      continue
    }
    const created = createDefectsForPatrol(patrol, defects, nextDefectId)
    if (created.length > 0) {
      defects.push(...created)
      nextDefectId += created.length
    }
  }
  data[DEFECT_KEY] = defects
  return data
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    // SSR / 测试环境没有 localStorage：用内存标记，也只回填一遍。
    return migratePatrolFindings(fallback, memoryBackfilled)
  }
  const alreadyBackfilled = window.localStorage.getItem(BACKFILL_KEY) === '1'
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = migratePatrolFindings(fallback, alreadyBackfilled)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    if (!alreadyBackfilled) {
      window.localStorage.setItem(BACKFILL_KEY, '1')
    }
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = migratePatrolFindings({ ...fallback, ...parsed }, alreadyBackfilled)
    if (!alreadyBackfilled) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
      window.localStorage.setItem(BACKFILL_KEY, '1')
    }
    return merged
  } catch {
    const reset = migratePatrolFindings(fallback, alreadyBackfilled)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reset))
    if (!alreadyBackfilled) {
      window.localStorage.setItem(BACKFILL_KEY, '1')
    }
    return reset
  }
}

let memoryBackfilled = false
let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
    memoryBackfilled = true
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveMany({ [key]: rows })
}

export function saveMany(patch: Record<string, EntryRow[]>): void {
  const next = { ...allRows(), ...patch }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  // 重置出的巡视种子同样归一一遍口径，但不重建缺陷（回填只对存量跑一次）。
  saveRows(
    key,
    key === PATROL_KEY
      ? sortByPatrolDate(rows).map((row) => {
          const normalized = normalizePatrolRow(row)
          if (String(normalized.status) === PATROL_STATUS_REPORTED) {
            return stampLegacyReport(normalized)
          }
          return normalized
        })
      : rows,
  )
  return listRows(key)
}

export function storageKey(): string {
  return STORAGE_KEY
}
