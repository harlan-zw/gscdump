// `pluralize` ships no types and `@types/pluralize` isn't worth a dep for the
// single function we use. Minimal local declaration for `.singular`.
declare module 'pluralize' {
  interface Pluralize {
    (word: string, count?: number, inclusive?: boolean): string
    singular: (word: string) => string
    plural: (word: string) => string
  }
  const pluralize: Pluralize
  export default pluralize
}
