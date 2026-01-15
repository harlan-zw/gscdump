import type { Column, Dimension } from './types'

function createColumn<D extends Dimension>(dimension: D): Column<D> {
  return { dimension } as Column<D>
}

export const page = createColumn('page')
export const query = createColumn('query')
export const device = createColumn('device')
export const country = createColumn('country')
export const searchAppearance = createColumn('searchAppearance')
export const date = createColumn('date')
