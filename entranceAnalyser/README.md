# Entrance Analyser

Sampling tool used to gather candidate sites for the OSM Science 2026
analysis of building-entrance mapping. Pulls inhabited areas from a
pre-computed GHS-POP grid stored in PostgreSQL, draws them on a
MapLibre map with togglable basemaps, and persists the operator's keep
/ reject decisions — along with downstream per-bbox analyses — in the
same database.

## Architecture

```
backend/   Rust (axum) + sqlx — Postgres/PostGIS persistence
           migrations/0001_init.sql  schema (grid + kept_bboxes + analyses)
           src/config.rs             PG_* env → database URL
           src/db.rs                 pool factory + embedded migrator
           src/sampler.rs            random draw from grid_cells
           src/storage.rs            PgStore: kept_bboxes + analyses
           src/bin/build_grid.rs     offline aggregation tool
frontend/  React + Vite + MapLibre GL — keep/reject UI
```

The HTTP backend serves three endpoints:

| Method | Path                  | Purpose                                                         |
|--------|-----------------------|-----------------------------------------------------------------|
| GET    | `/api/bbox/random`    | draw a candidate (503 if `grid_meta` is empty)                  |
| POST   | `/api/bbox/decision`  | keep or reject a previously drawn bbox (client echoes it back)  |
| GET    | `/api/bbox/kept`      | list every persisted kept bbox                                  |

## Bootstrapping

The backend refuses to serve random bboxes until the `grid_meta` /
`grid_cells` tables have been filled in. The full one-shot is ~few
minutes.

### 1. Provision a Postgres database with PostGIS

Any PostgreSQL 14+ install works as long as the `postgis` extension is
available on the server (Postgres.app, `brew install postgis`, or the
`postgis/postgis` Docker image).

Copy `.env.example` to `.env`, adjust `PG_CONNECTION_STRING_PREFIX` if
your server isn't at `localhost:5432`, then create the two databases
the project needs. You don't need `psql` / `createdb` on your `PATH` —
the backend ships a tiny helper that talks to the server over sqlx:

```bash
cd entranceAnalyser
cargo run --bin entrance-analyser-ensure-db
```

The command is idempotent (re-running it prints `already exists,
skipping`) and only creates the databases named in
`PG_DATABASE` / `PG_DATABASE_TEST`. If you do have the client tools
installed, `createdb "$PG_DATABASE" && createdb "$PG_DATABASE_TEST"`
works just as well.

Either way, the backend enables the PostGIS extension automatically on
startup via the embedded `0001_init.sql` migration — you do **not**
need to run `sqlx migrate run` by hand.

### 2. Download the source raster

[GHS-POP R2023A][ghs] — 2020 epoch, 1 km Mollweide (EPSG:54009),
~322 MB zipped:

```bash
curl -O 'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/GHS_POP_E2020_GLOBE_R2023A_54009_1000/V1-0/GHS_POP_E2020_GLOBE_R2023A_54009_1000_V1_0.zip'
unzip GHS_POP_E2020_GLOBE_R2023A_54009_1000_V1_0.zip
```

You only need the `.tif`; the rest of the archive is metadata.

> **Citation** (CC BY 4.0):
> Schiavina, M., Freire, S., MacManus, K. (2023): GHS-POP R2023A — GHS
> population grid multitemporal (1975–2030). European Commission, Joint
> Research Centre (JRC). DOI: [10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE](https://doi.org/10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE)

### 3. Aggregate into the grid tables

```bash
cd entranceAnalyser
cargo run --release --bin entrance-analyser-build-grid -- \
    --input /path/to/GHS_POP_E2020_GLOBE_R2023A_54009_1000_V1_0.tif \
    --cell-size-km 10
```

The binary reads `PG_CONNECTION_STRING_PREFIX + PG_DATABASE` from `.env`
by default; pass `--database-url` to override. Writes are idempotent
per `(cell_size_km, epoch)`: rebuilding with the same parameters
replaces the existing rows in a single transaction.

`--cell-size-km` is configurable from `1` (the source's native
resolution) up to `100`. Common picks:

| Cell size | Inhabited cells     |
|-----------|---------------------|
| 1 km      | ~15 M (estimate)    |
| 10 km     | ~808 k (measured)   |
| 25 km     | ~200 k (estimate)   |

Coarser grids don't shrink as N² because the `≥ min_population`
(default 0.5) threshold drops many sparsely-populated 1 km cells that
get rolled into still-inhabited 10 km ones. Only the 10 km row is a
measured figure from the 2020 epoch; the others are back-of-envelope.

`--min-population` defaults to `0.5` (drops empty / ocean cells).

### 4. Run the app

```bash
# In one terminal:
cd entranceAnalyser
cargo run --release --bin entrance-analyser-backend

# In another:
cd entranceAnalyser/frontend
yarn install
yarn dev
```

Open <http://127.0.0.1:5173>. The backend picks the most recently
built `(cell_size_km, epoch)` from `grid_meta` at startup and samples
from the matching `grid_cells` on every `/api/bbox/random` call.

## Tests

The integration suite spins up a disposable database named
`${PG_DATABASE_TEST}_<uuid>` for each test, applies the embedded
migrations, and drops it on teardown, so running `cargo test` twice in
a row leaves the server clean:

```bash
cd entranceAnalyser
cargo test                 # unit + integration, skips DB tests if offline
cd frontend && yarn test
```

Tests that need Postgres print `skipping db-backed test: ...` and
return early when the server is unreachable, so the suite stays green
on machines without a live database.

## Sampling performance note

`sample()` uses `ORDER BY random() LIMIT 1`, which is acceptable at our
scale (single-operator dev tool, ~800 k rows at 10 km). If the grid
ever grows or the workload becomes concurrent, swap in the
`tsm_system_rows` extension and `TABLESAMPLE SYSTEM_ROWS(1)` — that's
a one-query change in [`src/sampler.rs`](backend/src/sampler.rs).

[ghs]: https://human-settlement.emergency.copernicus.eu/ghs_pop2023.php
