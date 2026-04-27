import { describe, expect, it } from 'vitest'
import { bindLiterals, formatLiteral } from '../src/sql-bind'

describe('formatLiteral', () => {
  it('encodes nulls', () => {
    expect(formatLiteral(null)).toBe('NULL')
    expect(formatLiteral(undefined)).toBe('NULL')
  })

  it('encodes finite numbers', () => {
    expect(formatLiteral(42)).toBe('42')
    expect(formatLiteral(-0.5)).toBe('-0.5')
  })

  it('rejects non-finite numbers', () => {
    expect(() => formatLiteral(Number.NaN)).toThrow(/non-finite/)
    expect(() => formatLiteral(Infinity)).toThrow(/non-finite/)
  })

  it('encodes booleans + bigints + dates', () => {
    expect(formatLiteral(true)).toBe('TRUE')
    expect(formatLiteral(false)).toBe('FALSE')
    expect(formatLiteral(10n)).toBe('10')
    expect(formatLiteral(new Date('2026-04-10T00:00:00Z'))).toBe('\'2026-04-10T00:00:00.000Z\'')
  })

  it('escapes single quotes in strings', () => {
    expect(formatLiteral('O\'Brien')).toBe('\'O\'\'Brien\'')
    expect(formatLiteral('plain')).toBe('\'plain\'')
  })

  it('rejects control characters', () => {
    expect(() => formatLiteral('bad\x00char')).toThrow(/control characters/)
    expect(() => formatLiteral('tab\x0Bhere')).toThrow(/control characters/)
  })

  it('rejects unrepresentable types', () => {
    expect(() => formatLiteral({ a: 1 })).toThrow(/type object/)
    expect(() => formatLiteral(Symbol('x'))).toThrow(/type symbol/)
  })
})

describe('bindLiterals', () => {
  it('no-op when params empty', () => {
    expect(bindLiterals('SELECT 1', [])).toBe('SELECT 1')
  })

  it('substitutes placeholders in order', () => {
    expect(bindLiterals('SELECT ?, ?', [1, 'a'])).toBe('SELECT 1, \'a\'')
  })

  it('leaves ? inside string literals alone', () => {
    expect(bindLiterals('SELECT \'what?\' WHERE x = ?', [5])).toBe('SELECT \'what?\' WHERE x = 5')
  })

  it('handles SQL-standard quote escaping inside strings', () => {
    const out = bindLiterals('WHERE label = \'it\'\'s ?\' AND id = ?', [7])
    expect(out).toBe('WHERE label = \'it\'\'s ?\' AND id = 7')
  })

  it('throws when placeholders exceed params', () => {
    expect(() => bindLiterals('SELECT ?, ?', [1])).toThrow(/more '\?'/)
  })

  it('throws when params exceed placeholders', () => {
    expect(() => bindLiterals('SELECT ?', [1, 2])).toThrow(/unused/)
  })

  it('binds heterogeneous types across one statement', () => {
    const sql = 'INSERT INTO t VALUES (?, ?, ?, ?, ?)'
    const out = bindLiterals(sql, [null, 1, 'hi', true, new Date('2026-04-10T00:00:00Z')])
    expect(out).toBe('INSERT INTO t VALUES (NULL, 1, \'hi\', TRUE, \'2026-04-10T00:00:00.000Z\')')
  })

  it('leaves ? inside -- line comments alone', () => {
    const sql = 'SELECT ? -- x = ?\nFROM t WHERE y = ?'
    expect(bindLiterals(sql, [1, 2])).toBe('SELECT 1 -- x = ?\nFROM t WHERE y = 2')
  })

  it('leaves ? inside /* block */ comments alone', () => {
    const sql = 'SELECT ? /* hey ? there ? */ , ?'
    expect(bindLiterals(sql, [1, 2])).toBe('SELECT 1 /* hey ? there ? */ , 2')
  })

  it('handles unterminated block comment to end of input', () => {
    expect(bindLiterals('SELECT ? /* ? ? ', [1])).toBe('SELECT 1 /* ? ? ')
  })

  it('binds Postgres-style $N placeholders', () => {
    expect(bindLiterals('SELECT $1, $2', ['a', 42])).toBe('SELECT \'a\', 42')
  })

  it('binds the same $N multiple times', () => {
    expect(bindLiterals('SELECT $1, $1', ['x'])).toBe('SELECT \'x\', \'x\'')
  })

  it('rejects mixed ? and $N placeholders', () => {
    expect(() => bindLiterals('SELECT ?, $1', ['a', 'b']))
      .toThrow(/cannot mix/)
  })

  it('throws when $N is out of range', () => {
    expect(() => bindLiterals('SELECT $5', ['a']))
      .toThrow(/\$5 out of range/)
  })

  it('throws when a $N param is unused', () => {
    expect(() => bindLiterals('SELECT $1', ['a', 'b']))
      .toThrow(/1 params unused/)
  })

  it('leaves $N inside strings and comments untouched', () => {
    expect(bindLiterals('SELECT \'$1\', $1', ['x']))
      .toBe('SELECT \'$1\', \'x\'')
    expect(bindLiterals('SELECT $1 -- $2 keep\n', ['y']))
      .toBe('SELECT \'y\' -- $2 keep\n')
  })
})
