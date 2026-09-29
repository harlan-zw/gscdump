# gscdump

Google Search Console querying, Bing exports and Indexing Evidence, Analyzers, and an append-only Parquet Store.
The CLI has 2 access modes, Local and Hosted, shared across Google and Bing. Local calls Google with the user's own credentials. Hosted reads the gscdump.com record. The CLI MCP server needs Local mode.

[GLOSSARY.md](./GLOSSARY.md) owns vocabulary and concept relationships.
[ARCHITECTURE.md](./ARCHITECTURE.md) explains package boundaries.
[ROADMAP.md](./ROADMAP.md) records release checks and consumer migration gates.
