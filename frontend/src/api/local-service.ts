import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveMany, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import {
  DEFECT_KEY,
  FIELD_DEFECT_COUNT,
  FIELD_HANDLING,
  FIELD_PATROL_NO,
  PATROL_KEY,
  applyReport,
  countPatrolFindingsInMonth,
  createDefectsForPatrol,
  currentMonth,
  defectCountOf,
  displayHandling,
  hasFinding,
  isReported,
  normalizePatrolRow,
} from '@/domain/patrol-finding'

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

/**
 * 巡视记录对外的统一读法：发现缺陷数、处理情况都来自同一份共用判定，
 * 列表页与导出册子拿到的是完全相同的值，不存在两套口径。
 */
export function presentPatrolRows(rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => ({
    ...row,
    [FIELD_DEFECT_COUNT]: defectCountOf(row),
    [FIELD_HANDLING]: displayHandling(row),
  }))
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const source = listRows(key)
  const matched = key === PATROL_KEY ? presentPatrolRows(filterRows(source, filters)) : filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/**
 * 巡视上报问题：结论按共用口径判一次并固化；发现问题则按缺陷数生成
 * 缺陷处置待办。同一趟巡视（按巡视编号）已经上报过就拒绝，只算一遍。
 */
function reportPatrol(id: number): ActionResult {
  const rows = listRows(PATROL_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的巡视记录` }
  }
  const target = rows[index]
  if (isReported(target)) {
    return {
      ok: false,
      message: `巡视${String(target[FIELD_PATROL_NO] ?? id)}已上报过，同一趟巡视不重复上报`,
    }
  }

  const reported = applyReport(target)
  const patrolRows = [...rows]
  patrolRows[index] = reported

  const defects = listRows(DEFECT_KEY)
  const nextId = defects.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const created = createDefectsForPatrol(reported, defects, nextId)

  saveMany({
    [PATROL_KEY]: patrolRows,
    ...(created.length > 0 ? { [DEFECT_KEY]: [...defects, ...created] } : {}),
  })

  return {
    ok: true,
    message: hasFinding(reported)
      ? `巡视已上报：发现${defectCountOf(reported)}项缺陷，已生成${created.length}条缺陷处置待办`
      : '巡视已上报：本次未发现问题',
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  // 巡视上报走带结论固化与缺陷待办联动的专用实现。
  if (key === PATROL_KEY && target === '已上报') {
    return reportPatrol(id)
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
  let updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 巡视的其他流转同样过一遍共用口径，保证处理情况写法归一。
  if (key === PATROL_KEY) {
    updated = normalizePatrolRow(updated)
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 与列表页同源：巡视导出读到的发现缺陷数、处理情况就是列表那一份。
  const rows = key === PATROL_KEY ? presentPatrolRows(listRows(key)) : listRows(key)
  for (const row of rows) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }}

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

export function loadOverview(now: Date = new Date()): OverviewResult {
  const rows = allRows()
  const month = currentMonth(now)
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
      // 巡视模块挂「本月发现问题数」，口径与列表、导出是同一份共用实现。
      ...(meta.key === PATROL_KEY
        ? { findingsMonth: countPatrolFindingsInMonth(entries, month) }
        : {}),
    }
  })
  const patrols = rows[PATROL_KEY] ?? []
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    { label: '本月巡视发现问题数', value: countPatrolFindingsInMonth(patrols, month) },
  ]
  return { cards, modules, month }
}
