import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  DEFECT_KEY,
  FROZEN_COUNT_FIELD,
  FROZEN_HANDLING_FIELD,
  JUDGMENT_COLUMN,
  PATROL_KEY,
  REPORT_ACTION,
  REPORTED_STATUS,
  REPORT_DATE_FIELD,
  buildDefectsFromPatrol,
  formatDate,
  handlingText,
  isReported,
  judgmentLabel,
  monthlyProblemCount,
  patrolConclusion,
} from '@/data/patrol'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  // 巡视「上报问题」不只是状态流转：要冻结结论并驱动缺陷处置清单，单独走一条。
  if (key === PATROL_KEY && action === REPORT_ACTION) {
    return reportPatrol(id)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 巡视上报：结论走共用判定并冻结在记录上，历史结论之后不再被回填改动；
// 同时按结论把缺陷写进缺陷处置的待处理清单。同一趟巡视重复上报只算一遍。
function reportPatrol(id: number): ActionResult {
  const rows = listRows(PATROL_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的巡视记录` }
  }
  const row = rows[index]
  if (isReported(row)) {
    return { ok: false, message: '该巡视已上报过，结论保持当时结果，不重复计入' }
  }
  const conclusion = patrolConclusion(row)
  const handling = handlingText(conclusion.defectCount, true)
  const updated: EntryRow = {
    ...row,
    status: REPORTED_STATUS,
    pending: false,
    abnormal: false,
    处理情况: handling,
    [FROZEN_COUNT_FIELD]: conclusion.defectCount,
    [FROZEN_HANDLING_FIELD]: handling,
    [REPORT_DATE_FIELD]: formatDate(new Date()),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(PATROL_KEY, next)

  const defects = listRows(DEFECT_KEY)
  const created = buildDefectsFromPatrol(updated, defects)
  if (created.length > 0) {
    saveRows(DEFECT_KEY, [...defects, ...created])
  }
  if (conclusion.defectCount === 0) {
    return { ok: true, message: '巡视记录已上报，结论「无问题」，缺陷处置待处理清单不变' }
  }
  if (created.length === 0) {
    return { ok: true, message: '巡视记录已上报，对应缺陷已在待处理清单中，不重复生成' }
  }
  return {
    ok: true,
    message: `巡视记录已上报，结论「${conclusion.handling}」，已新增 ${created.length} 条缺陷到处置待处理清单`,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  // 巡视的导出册子与名单页读同一份数据：发现缺陷数来自同一存储，问题判定来自同一算法。
  const fields = key === PATROL_KEY ? withJudgmentColumn(meta.fields) : meta.fields
  const header = ['编号', ...fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    const cells = fields.map((field) => (field === JUDGMENT_COLUMN ? judgmentLabel(row) : row[field] ?? ''))
    lines.push([row.id, ...cells, row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

function withJudgmentColumn(fields: string[]): string[] {
  const next = [...fields]
  next.splice(next.indexOf('处理情况') + 1, 0, JUDGMENT_COLUMN)
  return next
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    // 概览的发现问题数与巡视名单、导出册子同一份判定
    { label: '本月发现问题数', value: monthlyProblemCount(rows[PATROL_KEY] ?? []) },
  ]
  return { cards, modules }
}
