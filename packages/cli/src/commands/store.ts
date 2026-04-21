import { defineCommand } from 'citty'
import { compactCommand } from './compact'
import { exportCommand } from './export'
import { gcCommand } from './gc'
import { statsCommand } from './stats'

export const storeCommand = defineCommand({
  meta: {
    name: 'store',
    description: 'Manage the local DuckDB/Parquet store',
  },
  subCommands: {
    stats: statsCommand,
    compact: compactCommand,
    gc: gcCommand,
    export: exportCommand,
  },
})
