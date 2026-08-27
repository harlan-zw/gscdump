import { searchTypeSchema } from '@gscdump/contracts'
import { GSC_SEARCH_TYPES } from '@gscdump/contracts/search-types'

describe('search type contracts', () => {
  it('accepts every canonical Search Type at the schema boundary', () => {
    for (const searchType of Object.values(GSC_SEARCH_TYPES))
      expect(searchTypeSchema.parse(searchType)).toBe(searchType)

    expect(searchTypeSchema.safeParse('blogs').success).toBe(false)
  })
})
