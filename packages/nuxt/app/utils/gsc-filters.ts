// Re-exports the typed query operators from `gscdump/query` so layer
// consumers can compose filters without an extra import line. Auto-imported
// like the layer's other utils.
//
// Usage:
//   const filter = and(
//     between(date, range.start, range.end),
//     eq(country, 'usa'),
//   )
//
// Replaces nuxtseo's wire-format `dateFilter` / `andFilter` helpers — both
// formats coerce to the same shape server-side, so the typed primitives
// are strictly better.

export {
  and,
  between,
  contains,
  eq,
  gt,
  gte,
  inArray,
  like,
  lt,
  lte,
  ne,
  not,
  notRegex,
  or,
  regex,
  topLevel,
} from 'gscdump/query'
