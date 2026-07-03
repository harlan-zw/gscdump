/**
 * Byte-identity proof (ADR-0021 R2-FIXES C5): the `defineIcebergDataset`-derived
 * `gsc.*` `IcebergDataset` instances (`../src/iceberg/schema.ts`'s `gscDataset`)
 * must be BYTE-IDENTICAL, for all 9 tables x both partition-key encodings, to
 * the ORIGINAL hand-written `icebergSchemaFor`/`icebergPartitionSpecFor`/
 * `icebergSortOrderFor` outputs as they existed immediately before the C5 port
 * (captured via a one-off `tsx` dump against the pre-port revision — see the
 * port commit message for the capture command). The fixture below is a frozen
 * COPY — never update it to "match" a future dataset-def change; a mismatch
 * here means the def changed the on-disk contract, which is exactly what this
 * test exists to catch (mirrors nuxtseo's `crawl-iceberg-dataset-shape.test.ts`
 * proof for `crawl.pages`/`crawl.findings`).
 */

import type { PartitionKeyEncoding } from '../src/iceberg/schema'
import { describe, expect, it } from 'vitest'
import { gscDataset, ICEBERG_TABLES } from '../src/iceberg/schema'

// Frozen fixture — the pre-C5 `icebergSchemaFor`/`icebergPartitionSpecFor`/
// `icebergSortOrderFor` outputs for all 9 tables x {'string', 'int'} encodings.
const ORIGINAL_SHAPES: Record<string, { schema: unknown, partitionSpec: unknown, sortOrder: unknown }> = {
  'pages::string': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'string',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'string',
        },
        {
          id: 3,
          name: 'url',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 5,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 6,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 7,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 4,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'pages::int': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'int',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'int',
        },
        {
          id: 3,
          name: 'url',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 5,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 6,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 7,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 4,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'queries::string': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'string',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'string',
        },
        {
          id: 3,
          name: 'query',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 5,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 6,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 7,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 4,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'queries::int': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'int',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'int',
        },
        {
          id: 3,
          name: 'query',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 5,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 6,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 7,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 4,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'countries::string': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'string',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'string',
        },
        {
          id: 3,
          name: 'country',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 5,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 6,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 7,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 4,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'countries::int': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'int',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'int',
        },
        {
          id: 3,
          name: 'country',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 5,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 6,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 7,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 4,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'page_queries::string': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'string',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'string',
        },
        {
          id: 3,
          name: 'url',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'query',
          required: true,
          type: 'string',
        },
        {
          id: 5,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 6,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 7,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 8,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 5,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 5,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'page_queries::int': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'int',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'int',
        },
        {
          id: 3,
          name: 'url',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'query',
          required: true,
          type: 'string',
        },
        {
          id: 5,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 6,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 7,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 8,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 5,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 5,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'dates::string': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'string',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'string',
        },
        {
          id: 3,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 4,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 5,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 6,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
        {
          id: 7,
          name: 'anonymized_impressions_pct',
          required: true,
          type: 'double',
        },
        {
          id: 8,
          name: 'clicks_desktop',
          required: true,
          type: 'int',
        },
        {
          id: 9,
          name: 'clicks_mobile',
          required: true,
          type: 'int',
        },
        {
          id: 10,
          name: 'clicks_tablet',
          required: true,
          type: 'int',
        },
        {
          id: 11,
          name: 'impressions_desktop',
          required: true,
          type: 'int',
        },
        {
          id: 12,
          name: 'impressions_mobile',
          required: true,
          type: 'int',
        },
        {
          id: 13,
          name: 'impressions_tablet',
          required: true,
          type: 'int',
        },
        {
          id: 14,
          name: 'sum_position_desktop',
          required: true,
          type: 'double',
        },
        {
          id: 15,
          name: 'sum_position_mobile',
          required: true,
          type: 'double',
        },
        {
          id: 16,
          name: 'sum_position_tablet',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 3,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'dates::int': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'int',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'int',
        },
        {
          id: 3,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 4,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 5,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 6,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
        {
          id: 7,
          name: 'anonymized_impressions_pct',
          required: true,
          type: 'double',
        },
        {
          id: 8,
          name: 'clicks_desktop',
          required: true,
          type: 'int',
        },
        {
          id: 9,
          name: 'clicks_mobile',
          required: true,
          type: 'int',
        },
        {
          id: 10,
          name: 'clicks_tablet',
          required: true,
          type: 'int',
        },
        {
          id: 11,
          name: 'impressions_desktop',
          required: true,
          type: 'int',
        },
        {
          id: 12,
          name: 'impressions_mobile',
          required: true,
          type: 'int',
        },
        {
          id: 13,
          name: 'impressions_tablet',
          required: true,
          type: 'int',
        },
        {
          id: 14,
          name: 'sum_position_desktop',
          required: true,
          type: 'double',
        },
        {
          id: 15,
          name: 'sum_position_mobile',
          required: true,
          type: 'double',
        },
        {
          id: 16,
          name: 'sum_position_tablet',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 3,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'search_appearance::string': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'string',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'string',
        },
        {
          id: 3,
          name: 'searchAppearance',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 5,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 6,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 7,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 4,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'search_appearance::int': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'int',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'int',
        },
        {
          id: 3,
          name: 'searchAppearance',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 5,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 6,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 7,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 4,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'search_appearance_pages::string': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'string',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'string',
        },
        {
          id: 3,
          name: 'searchAppearance',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'url',
          required: true,
          type: 'string',
        },
        {
          id: 5,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 6,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 7,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 8,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 5,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 5,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'search_appearance_pages::int': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'int',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'int',
        },
        {
          id: 3,
          name: 'searchAppearance',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'url',
          required: true,
          type: 'string',
        },
        {
          id: 5,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 6,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 7,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 8,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 5,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 5,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'search_appearance_queries::string': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'string',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'string',
        },
        {
          id: 3,
          name: 'searchAppearance',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'query',
          required: true,
          type: 'string',
        },
        {
          id: 5,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 6,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 7,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 8,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 5,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 5,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'search_appearance_queries::int': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'int',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'int',
        },
        {
          id: 3,
          name: 'searchAppearance',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'query',
          required: true,
          type: 'string',
        },
        {
          id: 5,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 6,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 7,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 8,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 5,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 5,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'search_appearance_page_queries::string': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'string',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'string',
        },
        {
          id: 3,
          name: 'searchAppearance',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'url',
          required: true,
          type: 'string',
        },
        {
          id: 5,
          name: 'query',
          required: true,
          type: 'string',
        },
        {
          id: 6,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 7,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 8,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 9,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 6,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 5,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 6,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
  'search_appearance_page_queries::int': {
    schema: {
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        {
          id: 1,
          name: 'site_id',
          required: true,
          type: 'int',
        },
        {
          id: 2,
          name: 'search_type',
          required: true,
          type: 'int',
        },
        {
          id: 3,
          name: 'searchAppearance',
          required: true,
          type: 'string',
        },
        {
          id: 4,
          name: 'url',
          required: true,
          type: 'string',
        },
        {
          id: 5,
          name: 'query',
          required: true,
          type: 'string',
        },
        {
          id: 6,
          name: 'date',
          required: true,
          type: 'date',
        },
        {
          id: 7,
          name: 'clicks',
          required: true,
          type: 'int',
        },
        {
          id: 8,
          name: 'impressions',
          required: true,
          type: 'int',
        },
        {
          id: 9,
          name: 'sum_position',
          required: true,
          type: 'double',
        },
      ],
    },
    partitionSpec: {
      'spec-id': 0,
      'fields': [
        {
          'source-id': 1,
          'field-id': 1000,
          'name': 'site_id',
          'transform': 'identity',
        },
        {
          'source-id': 2,
          'field-id': 1001,
          'name': 'search_type',
          'transform': 'identity',
        },
        {
          'source-id': 6,
          'field-id': 1002,
          'name': 'date_month',
          'transform': 'month',
        },
      ],
    },
    sortOrder: {
      'order-id': 1,
      'fields': [
        {
          'source-id': 3,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 4,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 5,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
        {
          'source-id': 6,
          'transform': 'identity',
          'direction': 'asc',
          'null-order': 'nulls-last',
        },
      ],
    },
  },
}

describe('gsc.* dataset-def byte-identity (9 tables x 2 encodings)', () => {
  for (const table of ICEBERG_TABLES) {
    for (const encoding of ['string', 'int'] as const satisfies PartitionKeyEncoding[]) {
      it(`${table} (${encoding}): def-derived schema/partitionSpec/sortOrder match the pre-C5 originals`, () => {
        const original = ORIGINAL_SHAPES[`${table}::${encoding}`]
        const ds = gscDataset(table, encoding)
        expect(ds.icebergSchema()).toEqual(original.schema)
        expect(ds.icebergPartitionSpec()).toEqual(original.partitionSpec)
        expect(ds.icebergSortOrder()).toEqual(original.sortOrder)
      })
    }
  }

  it('covers exactly 9 tables (Wave-1 frozen table count)', () => {
    expect(ICEBERG_TABLES).toHaveLength(9)
    expect(Object.keys(ORIGINAL_SHAPES)).toHaveLength(18)
  })
})
