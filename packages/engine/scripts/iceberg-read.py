#!/usr/bin/env python3
"""Read-back helper for LocalIcebergSink integration tests.

Queries a local Iceberg table through DuckDB's `iceberg` extension over the
REST catalog + MinIO — the same path the production server tail (DuckDB over
Iceberg files) uses.

Protocol: JSON job on stdin, rows as JSON on stdout.

  job = {
    "catalogUri": "http://localhost:8181",
    "namespace": "gsc",
    "warehouse": "gscdump-poc-warehouse",
    "s3": { "endpoint", "accessKeyId", "secretAccessKey", "region" },
    "sql": "SELECT ... FROM gsc.<namespace>.<table> ..."
  }

  result = { "rows": [ {col: value, ...}, ... ] }   or   { "error": "..." }
"""
import json
import sys

import duckdb


def main():
    job = json.load(sys.stdin)
    s3 = job["s3"]
    endpoint = s3["endpoint"]

    con = duckdb.connect()
    con.execute("INSTALL iceberg; LOAD iceberg;")
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute(
        f"""
        CREATE OR REPLACE SECRET minio (
            TYPE s3, KEY_ID '{s3["accessKeyId"]}', SECRET '{s3["secretAccessKey"]}',
            ENDPOINT '{endpoint}', URL_STYLE 'path',
            USE_SSL false, REGION '{s3.get("region", "us-east-1")}'
        );
        """
    )
    con.execute(
        f"""
        ATTACH '{job["warehouse"]}' AS gsc (
            TYPE iceberg, ENDPOINT '{job["catalogUri"]}',
            AUTHORIZATION_TYPE 'none'
        );
        """
    )

    cur = con.execute(job["sql"])
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    def encode(v):
        # JSON-safe: dates / decimals -> str; everything else passes through.
        if hasattr(v, "isoformat"):
            return v.isoformat()
        return v

    rows = [{k: encode(v) for k, v in row.items()} for row in rows]
    json.dump({"rows": rows}, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        json.dump({"error": f"{type(exc).__name__}: {exc}"}, sys.stdout)
        sys.exit(1)
