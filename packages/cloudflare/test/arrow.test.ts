import { SCHEMAS } from '@gscdump/engine/schema'
import { tableFromIPC, Type } from '@uwdata/flechette'
import { describe, expect, it } from 'vitest'
import { rowsToArrowIPC } from '../src/arrow'

// Decode an IPC buffer back to a flechette table for assertions.
function decode(ipc: Uint8Array) {
  return tableFromIPC(ipc)
}

function fieldType(table: ReturnType<typeof decode>, name: string): number {
  const field = table.schema.fields.find(f => f.name === name)
  if (!field)
    throw new Error(`column ${name} missing from encoded schema`)
  return field.type.typeId
}

describe('rowsToArrowIPC', () => {
  it('encodes string columns as plain utf8, never dictionary', () => {
    // A dictionary-encoded column would make `insertArrowFromIPCStream` reject
    // the stream — the inference fallback must force plain utf8.
    const table = decode(rowsToArrowIPC([{ s: 'a' }, { s: 'b' }, { s: 'a' }]))
    expect(fieldType(table, 's')).toBe(Type.Utf8)
    expect(table.toArray().map(r => r.s)).toEqual(['a', 'b', 'a'])
  })

  it('encodes an all-null column as utf8, never the null type', () => {
    // flechette would infer nullType() for an all-null column, which lands as
    // a DuckDB NULL-typed column and breaks downstream CAST/comparison.
    const table = decode(rowsToArrowIPC([{ x: null }, { x: null }]))
    expect(fieldType(table, 'x')).toBe(Type.Utf8)
    expect(table.numRows).toBe(2)
  })

  it('emits the union of columns across heterogeneous rows', () => {
    // Building from rows[0] alone would drop `b` — a coarse tier file can
    // carry a column an older file lacks.
    const table = decode(rowsToArrowIPC([{ a: 1 }, { a: 2, b: 'x' }]))
    expect(table.schema.fields.map(f => f.name).sort()).toEqual(['a', 'b'])
    expect(table.toArray().map(r => r.b)).toEqual([null, 'x'])
  })

  it('types fact columns from the supplied schema', () => {
    const rows = [{ url: '/', date: '2026-01-01', clicks: 5, impressions: 9, sum_position: 1.5 }]
    const table = decode(rowsToArrowIPC(rows, SCHEMAS.pages.columns))
    expect(fieldType(table, 'url')).toBe(Type.Utf8)
    expect(fieldType(table, 'date')).toBe(Type.Utf8)
    expect(fieldType(table, 'clicks')).toBe(Type.Int)
    expect(fieldType(table, 'impressions')).toBe(Type.Int)
    expect(fieldType(table, 'sum_position')).toBe(Type.Float)
  })

  it('maps a BIGINT schema column to a 64-bit int', () => {
    const table = decode(rowsToArrowIPC(
      [{ n: 5 }],
      [{ name: 'n', type: 'BIGINT', nullable: false }],
    ))
    const field = table.schema.fields.find(f => f.name === 'n')!
    expect(field.type.typeId).toBe(Type.Int)
    expect((field.type as { bitWidth?: number }).bitWidth).toBe(64)
    expect(Number(table.toArray()[0]!.n)).toBe(5)
  })

  it('encodes a zero-row table carrying the full schema', () => {
    // An empty placeholder still ships a schema so the sibling materializes a
    // typed 0-row table — no DDL special-case needed.
    const table = decode(rowsToArrowIPC([], SCHEMAS.pages.columns))
    expect(table.numRows).toBe(0)
    expect(table.schema.fields.map(f => f.name).sort())
      .toEqual(SCHEMAS.pages.columns.map(c => c.name).sort())
  })
})
