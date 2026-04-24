# Entrance Analyser

Sampling tool used to gather candidate sites for the OSM Science 2026
analysis of building-entrance mapping. Pulls inhabited areas from a
pre-computed GHS-POP grid, draws them on a MapLibre map with togglable
basemaps, and persists the user's keep / reject decisions to a local
JSON file.

## Architecture

```
backend/   Rust (axum) — random sampling + atomic JSON store
           src/grid.rs        on-disk grid format ("EAGD")
           src/sampler.rs     uniform draw from the grid
           src/bin/build_grid.rs   offline aggregation tool
frontend/  React + Vite + MapLibre GL — keep/reject UI
data/      gitignored — grid file + kept_bboxes.json
```

The HTTP backend serves three endpoints:

| Method | Path                  | Purpose                                                         |
|--------|-----------------------|-----------------------------------------------------------------|
| GET    | `/api/bbox/random`    | draw a candidate (503 if no grid is loaded)                     |
| POST   | `/api/bbox/decision`  | keep or reject a previously drawn bbox                          |
| GET    | `/api/bbox/kept`      | list every persisted kept bbox                                  |

## Bootstrapping the world grid

The backend refuses to serve random bboxes until a `EAGD` grid file
exists on disk. Building one is a one-shot, ~few-minute step.

### 1. Download the source raster

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

### 2. Aggregate into the grid file

```bash
cd entranceAnalyser
cargo run --release --bin entrance-analyser-build-grid -- \
    --input  /path/to/GHS_POP_E2020_GLOBE_R2023A_54009_1000_V1_0.tif \
    --output data/world_grid_2020_10km.bin \
    --cell-size-km 10
```

`--cell-size-km` is configurable from `1` (the source's native
resolution; ~200 MB output) up to `100`. Common picks:

| Cell size | Cells (inhabited only) | File size |
|-----------|------------------------|-----------|
| 1 km      | ~15 M                  | ~180 MB   |
| 5 km      | ~600 k                 | ~7 MB     |
| 10 km     | ~150 k                 | ~2 MB     |
| 25 km     | ~25 k                  | ~300 KB   |

`--min-population` defaults to `0.5` (drop empty / ocean cells).

### 3. Run the app

```bash
# In one terminal:
cd entranceAnalyser
cargo run --release

# In another:
cd entranceAnalyser/frontend
yarn install
yarn dev
```

Open <http://127.0.0.1:5173>. The backend looks for the grid at
`ENTRANCE_ANALYSER_GRID` (defaults to `data/world_grid_2020_10km.bin`),
and writes kept bboxes to `ENTRANCE_ANALYSER_DATA` (defaults to
`data/kept_bboxes.json`).

## Tests

```bash
cd entranceAnalyser
cargo test                 # 42 unit + 1 integration test
cd frontend && yarn test   # 29 vitest
```

[ghs]: https://human-settlement.emergency.copernicus.eu/ghs_pop2023.php
