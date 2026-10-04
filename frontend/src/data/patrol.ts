import type { EntryRow } from './types'

// 巡视「是否发现问题」的共用判定：列表、导出、概览、上报全都走这一份，不再各写一套。
// 判定只认「发现缺陷数」这一个字段；「处理情况」的写法也在这里归一，别处不另造措辞。

export const PATROL_KEY = 'patrol'
export const DEFECT_KEY = 'defect'
export const REPORT_ACTION = '上报问题'
export const REPORTED_STATUS = '已上报'

// 上报时把结论冻结到这几个字段上：历史里已上报的巡视，之后的回填、重算都不再改它的结论。
export const FROZEN_COUNT_FIELD = '上报时缺陷数'
export const FROZEN_HANDLING_FIELD = '上报时处理情况'
export const REPORT_DATE_FIELD = '上报日期'

// 列表与导出册子共用的判定列名。
export const JUDGMENT_COLUMN = '问题判定'

export type PatrolConclusion = {
  defectCount: number
  hasProblem: boolean
  handling: string
  reported: boolean
  frozen: boolean
}

// 兼容存量数据：数值与纯数字字符串直接认；历史文本里夹带的数字（如「设备巡视样例2」）取第一个整数；
// 完全认不出来的返回 null，交给回填兜底。
export function parseDefectCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10)
    }
    const embedded = trimmed.match(/\d+/)
    if (embedded) {
      return Number.parseInt(embedded[0], 10)
    }
  }
  return null
}

// 处理情况的归一写法，全系统只有这一种措辞。
export function handlingText(defectCount: number, reported: boolean): string {
  if (defectCount <= 0) {
    return '无问题'
  }
  return reported ? `发现${defectCount}项缺陷，已上报` : `发现${defectCount}项缺陷，待上报`
}

// 一条巡视的结论：有冻结快照用快照（已上报的保持当时的结论），否则按发现缺陷数现算。
export function patrolConclusion(row: EntryRow): PatrolConclusion {
  const frozenCount = parseDefectCount(row[FROZEN_COUNT_FIELD])
  if (frozenCount !== null) {
    const handling = String(row[FROZEN_HANDLING_FIELD] ?? handlingText(frozenCount, true))
    return { defectCount: frozenCount, hasProblem: frozenCount > 0, handling, reported: true, frozen: true }
  }
  const defectCount = parseDefectCount(row['发现缺陷数']) ?? 0
  const reported = String(row.status) === REPORTED_STATUS
  return {
    defectCount,
    hasProblem: defectCount > 0,
    handling: handlingText(defectCount, reported),
    reported,
    frozen: false,
  }
}

// 是否已上报（含已冻结结论的历史记录）：已上报的巡视再提交一次只算一遍。
export function isReported(row: EntryRow): boolean {
  return String(row.status) === REPORTED_STATUS || patrolConclusion(row).frozen
}

// 列表与导出共用的问题判定文字。
export function judgmentLabel(row: EntryRow): string {
  return patrolConclusion(row).hasProblem ? '发现问题' : '无问题'
}

// 单条归一：发现缺陷数回填成数值、处理情况归一；已上报但没有快照的，按当前数据冻结当时的结论。
export function normalizePatrolRow(row: EntryRow): EntryRow {
  const frozenCount = parseDefectCount(row[FROZEN_COUNT_FIELD])
  if (frozenCount !== null) {
    // 已冻结的历史结论不动，发现缺陷数以冻结值为准。
    return {
      ...row,
      发现缺陷数: frozenCount,
      处理情况: String(row[FROZEN_HANDLING_FIELD] ?? handlingText(frozenCount, true)),
    }
  }
  const defectCount = parseDefectCount(row['发现缺陷数']) ?? 0
  const reported = String(row.status) === REPORTED_STATUS
  const handling = handlingText(defectCount, reported)
  if (reported) {
    // 历史里已经上报过的：冻结当时的结论，之后的回填与重算都不再改它。
    return {
      ...row,
      发现缺陷数: defectCount,
      处理情况: handling,
      [FROZEN_COUNT_FIELD]: defectCount,
      [FROZEN_HANDLING_FIELD]: handling,
      [REPORT_DATE_FIELD]: String(row[REPORT_DATE_FIELD] ?? row['巡视日期'] ?? ''),
    }
  }
  return { ...row, 发现缺陷数: defectCount, 处理情况: handling }
}

function byPatrolDate(a: EntryRow, b: EntryRow): number {
  const byDate = String(a['巡视日期'] ?? '').localeCompare(String(b['巡视日期'] ?? ''))
  return byDate !== 0 ? byDate : Number(a.id) - Number(b.id)
}

// 存量巡视记录按巡视日期顺序回填一遍；返回顺序与传入一致，调用方才敢直接替换。
// 反复执行结果不变（幂等），刷新、重开都不会越改越乱。
export function backfillPatrolRows(rows: EntryRow[]): EntryRow[] {
  const normalized = new Map<number, EntryRow>()
  for (const row of [...rows].sort(byPatrolDate)) {
    normalized.set(Number(row.id), normalizePatrolRow(row))
  }
  return rows.map((row) => normalized.get(Number(row.id)) ?? row)
}

// 概览与列表共用的「本月发现问题数」：按巡视日期落在本月过滤，结论走同一份判定。
export function monthlyProblemCount(rows: EntryRow[], now: Date = new Date()): number {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return rows.reduce((sum, row) => {
    const date = String(row['巡视日期'] ?? '')
    return date.startsWith(month) ? sum + patrolConclusion(row).defectCount : sum
  }, 0)
}

export function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// 由上报结论生成缺陷处置的待处理记录：结论说有几项缺陷就生成几条，状态「待处理」。
// 已存在同一来源巡视的缺陷时返回空数组，保证同一趟巡视只算一遍。
export function buildDefectsFromPatrol(patrol: EntryRow, existing: EntryRow[], now: Date = new Date()): EntryRow[] {
  const conclusion = patrolConclusion(patrol)
  if (conclusion.defectCount === 0) {
    return []
  }
  const source = String(patrol['巡视编号'] ?? patrol.id)
  if (existing.some((row) => String(row['来源巡视编号'] ?? '') === source)) {
    return []
  }
  const deadline = new Date(now)
  deadline.setDate(deadline.getDate() + 7)
  const firstId = existing.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  return Array.from({ length: conclusion.defectCount }, (_, offset) => {
    const id = firstId + offset
    return {
      id,
      status: '待处理',
      pending: true,
      abnormal: false,
      缺陷编号: `DEFE-${String(id).padStart(4, '0')}`,
      缺陷设备: String(patrol['巡视变电站'] ?? ''),
      缺陷等级: '一般',
      缺陷描述: `巡视${source}发现（第${offset + 1}项）`,
      发现人: String(patrol['巡视人'] ?? ''),
      处理期限: formatDate(deadline),
      处理人: '待指派',
      缺陷状态: '待处理',
      来源巡视编号: source,
    }
  })
}
