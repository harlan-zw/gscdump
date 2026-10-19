Offline synthetic Parquet compatibility fixtures. No customer data.

existing-nearcap.parquet: DuckDB 1.5.5, 25,000 synthetic appearance rows,
one ~15 MiB PLAIN UTF8 data page without an offset index, dictionary-coded
metrics with final 256-value block padding. File SHA256:
87a103ed7cf280053f462f899bba1c511fd6929f7c5d8f1de66a10f78db956ec.

mixed-plain_dictionary.parquet and mixed-rle_dictionary.parquet:
minimal REQUIRED UTF8 dictionary page followed by a dictionary data page
and a PLAIN data page, generated with hyparquet-writer page/footer writers.

unsupported-later-delta.parquet: a valid PLAIN prefix followed by a valid
DELTA_BINARY_PACKED page. The default decoder accepts it; strict mode must
discover unsupported encoding before yielding the prefix.

malformed-string-length.parquet: one BYTE_ARRAY prefix declares 2,147,483,647
bytes with only one following byte. Never execute the default eager decoder
against this corruption fixture; strict admission must refuse first.

The fixtures were generated independently of the candidate reader and checked
against the unchanged @gscdump/engine 7.4.0 decoder. Tests compare exact rows,
order and null/type semantics rather than generated Parquet byte equality.
