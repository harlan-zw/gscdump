#!/usr/bin/env python3
"""LocalIcebergSink writer backend — drives PyIceberg against a local Iceberg
REST catalog (the POC stack: `apache/iceberg-rest-fixture` + MinIO).

Reproduces the *outcome* of a Cloudflare Pipeline sinking into R2 Data Catalog,
exactly as the Phase-0 POC loader (`poc/iceberg/scripts/load_iceberg.py`) does.

Protocol: one JSON job per process, read from stdin, result written to stdout.

  job = {
    "op": "emit" | "overwrite" | "delete" | "close",
    "catalogUri": "http://localhost:8181",
    "namespace": "gsc",
    "warehouse": "gscdump-poc-warehouse",
    "s3": { "endpoint", "accessKeyId", "secretAccessKey", "region" },
    "table": "pages",
    "spec": IcebergTableSpec (from @gscdump/engine iceberg-schema),
    "siteId": "site-1",
    "searchType": "web",
    "date": "2026-04-01",
    "rows": [ { col: value, ... }, ... ]   # data columns only
  }

  result = { "rowCount": N }   or   { "error": "..." }

`emit` appends; `overwrite` replaces every row in the
(site_id, search_type, month(date)) partition matching the slice's exact date.
`delete` removes every row for a `site_id` (recovery: clear one site's data
from a per-team shard before a clean re-backfill); it carries no rows.
`close` is a no-op (PyIceberg commits per call).
"""
import json
import sys
from datetime import date as _date

import pyarrow as pa
from pyiceberg.catalog.rest import RestCatalog
from pyiceberg.expressions import And, EqualTo
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import IdentityTransform, MonthTransform
from pyiceberg.types import (
    DateType,
    DoubleType,
    IntegerType,
    LongType,
    NestedField,
    StringType,
)

_TYPE_MAP = {
    "STRING": StringType,
    "INT": IntegerType,
    "LONG": LongType,
    "DOUBLE": DoubleType,
    "DATE": DateType,
}

_ARROW_MAP = {
    "STRING": pa.string(),
    "INT": pa.int32(),
    "LONG": pa.int64(),
    "DOUBLE": pa.float64(),
    "DATE": pa.date32(),
}


def _s3_endpoint(s3):
    """Normalise the endpoint to an explicit scheme so S3FileIO doesn't
    default to HTTPS against a plain-HTTP MinIO."""
    ep = s3["endpoint"]
    if ep.startswith("http://") or ep.startswith("https://"):
        return ep
    return f"http://{ep}"


def _catalog(job):
    s3 = job["s3"]
    props = {
        "s3.endpoint": _s3_endpoint(s3),
        "s3.access-key-id": s3["accessKeyId"],
        "s3.secret-access-key": s3["secretAccessKey"],
        "s3.region": s3.get("region", "us-east-1"),
        "s3.path-style-access": "true",
    }
    # R2 Data Catalog's REST endpoint is token-authed (the POC's local catalog
    # is open). When `catalogToken` is present, pass it as the RestCatalog
    # bearer token so the same script drives both stacks.
    token = job.get("catalogToken")
    if token:
        props["token"] = token
    return RestCatalog(
        "local",
        uri=job["catalogUri"],
        warehouse=job["warehouse"],
        **props,
    )


def _schema(spec) -> Schema:
    fields = []
    for col in spec["columns"]:
        fields.append(
            NestedField(
                col["fieldId"],
                col["name"],
                _TYPE_MAP[col["type"]](),
                required=col["required"],
            )
        )
    return Schema(*fields)


def _partition_spec(spec) -> PartitionSpec:
    # Field ids 1000+ for partition fields; source ids resolved by column name.
    by_name = {c["name"]: c["fieldId"] for c in spec["columns"]}
    fields = []
    for i, pf in enumerate(spec["partitionSpec"]):
        transform = (
            MonthTransform() if pf["transform"] == "month" else IdentityTransform()
        )
        fields.append(
            PartitionField(
                source_id=by_name[pf["sourceColumn"]],
                field_id=1000 + i,
                transform=transform,
                name=pf["name"],
            )
        )
    return PartitionSpec(*fields)


def _arrow_table(spec, rows):
    cols = {}
    schema_fields = []
    for col in spec["columns"]:
        name = col["name"]
        arrow_type = _ARROW_MAP[col["type"]]
        values = [r.get(name) for r in rows]
        if col["type"] == "DATE":
            # JSON carries dates as `YYYY-MM-DD` strings; date32 needs date objects.
            values = [
                v if v is None or isinstance(v, _date) else _date.fromisoformat(v)
                for v in values
            ]
        cols[name] = values
        schema_fields.append(pa.field(name, arrow_type, nullable=not col["required"]))
    return pa.table(cols, schema=pa.schema(schema_fields))


def _ensure_table(cat, job):
    spec = job["spec"]
    ident = f"{job['namespace']}.{job['table']}"
    if not cat.table_exists(ident):
        if (job["namespace"],) not in cat.list_namespaces():
            cat.create_namespace(job["namespace"])
        cat.create_table(
            ident,
            schema=_schema(spec),
            partition_spec=_partition_spec(spec),
            properties={"write.parquet.compression-codec": "snappy"},
        )
    return cat.load_table(ident)


def _inject_partition_columns(job):
    """Emitted rows carry data columns only; inject the partition identity
    columns the slice owns: site_id, search_type, and the slice's `date`
    (a required, non-nullable table column sourced from SinkSlice.date)."""
    out = []
    for r in job["rows"]:
        row = dict(r)
        row["site_id"] = job["siteId"]
        row["search_type"] = job["searchType"]
        row.setdefault("date", job["date"])
        out.append(row)
    return out


def main():
    job = json.load(sys.stdin)
    op = job["op"]

    if op == "close":
        json.dump({"rowCount": 0}, sys.stdout)
        return

    cat = _catalog(job)

    if op == "delete":
        # Remove every row for one site across the whole table (all dates /
        # search types). Recovery op: clear a corrupt site (e.g. a cross-run
        # double) before a clean re-backfill, without touching sibling sites
        # in the shared per-team shard. `site_id` is an identity partition
        # column, so this prunes whole data files (no row-level delete files).
        # The table must already exist (no `spec` needed to delete) — load it
        # directly rather than _ensure_table.
        ident = f"{job['namespace']}.{job['table']}"
        tbl = cat.load_table(ident)
        deleted_before = tbl.scan(row_filter=EqualTo("site_id", job["siteId"])).count()
        tbl.delete(delete_filter=EqualTo("site_id", job["siteId"]))
        json.dump({"rowCount": deleted_before}, sys.stdout)
        return

    tbl = _ensure_table(cat, job)
    rows = _inject_partition_columns(job)
    arrow = _arrow_table(job["spec"], rows)
    arrow = arrow.cast(tbl.schema().as_arrow())

    if op == "emit":
        tbl.append(arrow)
    elif op == "overwrite":
        # Partition-overwrite: replace every row for this exact slice
        # (site_id + search_type + date). `month(date)` is a partition
        # transform; filtering on the `date` column itself is exact.
        flt = And(
            And(
                EqualTo("site_id", job["siteId"]),
                EqualTo("search_type", job["searchType"]),
            ),
            EqualTo("date", job["date"]),
        )
        tbl.overwrite(arrow, overwrite_filter=flt)
    else:
        json.dump({"error": f"unknown op '{op}'"}, sys.stdout)
        return

    json.dump({"rowCount": arrow.num_rows}, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — surface any failure to the caller
        json.dump({"error": f"{type(exc).__name__}: {exc}"}, sys.stdout)
        sys.exit(1)
