import type { EntryRow } from '@/data/types'

/**
 * 巡视「是否发现问题」的唯一判定来源。
 *
 * 列表、导出册子、概览统计都必须走这里，不允许再各写一套。
 * 判定口径：发现缺陷数大于零即「发现问题」，否则「未发现问题」；
 * 已经上报过的历史巡视只认上报当时留存的结论快照，不重新改判。
 */

export const PATROL_KEY = 'patrol'
export const DEFECT_KEY = 'defect'

export const FIELD_DEFECT_COUNT = '发现缺陷数'
export const FIELD_HANDLING = '处理情况'
export const FIELD_PATROL_DATE = '巡视日期'
export const FIELD_PATROL_NO = '巡视编号'
export const FIELD_STATION = '巡视变电站'
export const FIELD_ROUTE = '巡视路线'
export const FIELD_INSPECTOR = '巡视人'

export const PATROL_STATUS_PENDING = '待巡视'
export const PATROL_STATUS_DOING = '巡视中'
export const PATROL_STATUS_DONE = '已完成'
export const PATROL_STATUS_REPORTED = '已上报'

export const DEFECT_STATUS_OPEN = '待处理'

// 内部字段：上报当时留存的结论快照（“发现问题”/“未发现问题”）。
// 历史已上报记录即使后来数据被整理，也以这份快照为准。
export const SNAPSHOT_CONCLUSION = '上报结论快照'
// 内部字段：上报动作是否已生效，用于同一趟巡视重复提交只算一遍。
export const REPORTED_FLAG = '已上报标记'
// 内部字段：关联的巡视编号，供上报生成的缺陷溯源。
export const SOURCE_PATROL_NO = '来源巡视编号'

export type PatrolConclusion = '发现问题' | '未发现问题'

/** 处理情况栏的统一写法。历史已上报记录保留上报当时的原文，不在这里改。 */
export function formatHandling(defectCount: number, reported: boolean): string {
  if (defectCount > 0) {
    return reported ? `发现${defectCount}项缺陷，已上报处置` : `发现${defectCount}项缺陷，待上报`
  }
  return '未发现缺陷'
}

/**
 * 兼容历史写法：从「发现缺陷数」字段取数；字段缺失或不是数字时，
 * 才退回到老的处理情况文字里识别一次（只在存量回填时使用）。
 */
export function parseDefectCount(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw >= 0 ? Math.trunc(raw) : 0
  }
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') {
      return 0
    }
    const numeric = Number(text)
    if (Number.isFinite(numeric)) {
      return numeric >= 0 ? Math.trunc(numeric) : 0
    }
    const matched = text.match(/(\d+)\s*[项个条]?\s*缺陷/)
    if (matched) {
      return Number(matched[1])
    }
    if (/有问题|有缺陷|发现问题/.test(text)) {
      return 1
    }
  }
  return 0
}

/** 取一条巡视记录归一后的发现缺陷数（非负整数）。 */
export function defectCountOf(row: EntryRow): number {
  return parseDefectCount(row[FIELD_DEFECT_COUNT])
}

export function isReported(row: EntryRow): boolean {
  return row[REPORTED_FLAG] === true || String(row.status) === PATROL_STATUS_REPORTED
}

/**
 * 唯一的结论判定：先看上报快照（历史已上报结论不可改），
 * 没有快照再按发现缺陷数是否大于零判。
 */
export function patrolConclusion(row: EntryRow): PatrolConclusion {
  if (row[SNAPSHOT_CONCLUSION] === '发现问题' || row[SNAPSHOT_CONCLUSION] === '未发现问题') {
    return row[SNAPSHOT_CONCLUSION]
  }
  return defectCountOf(row) > 0 ? '发现问题' : '未发现问题'
}

export function hasFinding(row: EntryRow): boolean {
  return patrolConclusion(row) === '发现问题'
}

/**
 * 归一后对外展示/导出的处理情况：
 * 已上报且留有历史原文的记录保留当时结论原文；其余走统一写法。
 */
export function displayHandling(row: EntryRow): string {
  if (isReported(row)) {
    const raw = String(row[FIELD_HANDLING] ?? '').trim()
    if (raw !== '') {
      return raw
    }
  }
  return formatHandling(defectCountOf(row), isReported(row))
}

/**
 * 给一条巡视记录套上唯一口径：发现缺陷数归一为整数、处理情况按统一写法补齐。
 * 历史已上报记录只归一缺陷数，处理情况原文与结论快照原样保留。
 */
export function normalizePatrolRow(row: EntryRow): EntryRow {
  const count = defectCountOf(row)
  const reported = isReported(row)
  const next: EntryRow = { ...row, [FIELD_DEFECT_COUNT]: count }
  if (reported) {
    const raw = String(row[FIELD_HANDLING] ?? '').trim()
    next[FIELD_HANDLING] = raw !== '' ? raw : formatHandling(count, true)
  } else {
    next[FIELD_HANDLING] = formatHandling(count, false)
  }
  return next
}

/** 概览口径：一批巡视记录里发现问题的有多少条（唯一口径，供三处共用）。 */
export function countPatrolFindings(rows: EntryRow[]): number {
  return rows.filter(hasFinding).length
}

/** 概览口径：一批巡视记录的发现缺陷总数。 */
export function sumDefectCount(rows: EntryRow[]): number {
  return rows.reduce((sum, row) => sum + defectCountOf(row), 0)
}

function monthKeyOf(raw: unknown): string {
  return String(raw ?? '').slice(0, 7)
}

/** 概览口径：某个月（YYYY-MM）巡视发现问题的记录数。 */
export function countPatrolFindingsInMonth(rows: EntryRow[], month: string): number {
  return rows
    .filter((row) => monthKeyOf(row[FIELD_PATROL_DATE]) === month)
    .filter(hasFinding).length
}

export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** 按巡视日期顺序（同日按编号）排列，存量回填与上报都按这个顺序走。 */
export function sortByPatrolDate(rows: EntryRow[]): EntryRow[] {
  return [...rows].sort((a, b) => {
    const dateA = String(a[FIELD_PATROL_DATE] ?? '')
    const dateB = String(b[FIELD_PATROL_DATE] ?? '')
    if (dateA !== dateB) {
      return dateA < dateB ? -1 : 1
    }
    return Number(a.id) - Number(b.id)
  })
}

/**
 * 上报一趟巡视：盖结论快照、归一处理情况写法。
 * 同一趟巡视是否已经上报过，由调用方先查 isReported，保证只算一遍。
 */
export function applyReport(row: EntryRow): EntryRow {
  const count = defectCountOf(row)
  const conclusion: PatrolConclusion = count > 0 ? '发现问题' : '未发现问题'
  return {
    ...row,
    status: PATROL_STATUS_REPORTED,
    [FIELD_HANDLING]: formatHandling(count, true),
    [SNAPSHOT_CONCLUSION]: conclusion,
    [REPORTED_FLAG]: true,
    pending: false,
  }
}

/**
 * 存量回填专用：历史已上报、但还没有结论快照的巡视，
 * 按上报当时留下来的证据（发现缺陷数、处理情况原文）把当时结论补盖一次，
 * 只此一次，之后展示与统计都只认快照。
 */
export function stampLegacyReport(row: EntryRow): EntryRow {
  if (row[SNAPSHOT_CONCLUSION] === '发现问题' || row[SNAPSHOT_CONCLUSION] === '未发现问题') {
    return { ...row, [REPORTED_FLAG]: true }
  }
  const count = defectCountOf(row)
  const text = String(row[FIELD_HANDLING] ?? '')
  const legacyHasFinding =
    count > 0 || /有问题|有缺陷|发现[^，。]*缺陷|缺陷\s*\d+\s*[处项个条]|异常/.test(text)
  return {
    ...row,
    [SNAPSHOT_CONCLUSION]: legacyHasFinding ? '发现问题' : '未发现问题',
    [REPORTED_FLAG]: true,
  }
}

/**
 * 巡视上报结论驱动缺陷处置待办：一趟巡视判「发现问题」后，
 * 按发现缺陷数生成对应数量的「待处理」缺陷。已关联过的巡视不重复生成，
 * 同一趟巡视再提交一次只算一遍。
 */
export function createDefectsForPatrol(
  patrol: EntryRow,
  existing: EntryRow[],
  nextId: number,
): EntryRow[] {
  const patrolNo = String(patrol[FIELD_PATROL_NO] ?? `P-${patrol.id}`)
  if (existing.some((defect) => String(defect[SOURCE_PATROL_NO] ?? '') === patrolNo)) {
    return []
  }
  if (!hasFinding(patrol)) {
    return []
  }
  const station = String(patrol[FIELD_STATION] ?? '')
  const inspector = String(patrol[FIELD_INSPECTOR] ?? '')
  const created: EntryRow[] = []
  for (let index = 1; index <= defectCountOf(patrol); index += 1) {
    created.push({
      id: nextId + index - 1,
      status: DEFECT_STATUS_OPEN,
      pending: true,
      abnormal: false,
      缺陷编号: `${patrolNo}-${index}`,
      缺陷设备: station,
      缺陷等级: '未分级',
      缺陷描述: `巡视${patrolNo}发现的第${index}项缺陷`,
      发现人: inspector,
      处理期限: '',
      处理人: '',
      缺陷状态: DEFECT_STATUS_OPEN,
      [SOURCE_PATROL_NO]: patrolNo,
    })
  }
  return created
}
