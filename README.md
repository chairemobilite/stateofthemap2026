# stateofthemap2026

Monorepo for the OSM Science 2026 submission on **building entrance locations
in OpenStreetMap and their effect on transport analysis and accessibility**.

It bundles two independent deliverables:

1. The academic paper (`main.tex`, `bibliography.bib`) — also synced with
   Overleaf.
2. The **Entrance Analyser** sampling tool (`entranceAnalyser/`) — a small
   Rust + React/MapLibre web app used to collect and analyse candidate
   sites on the globe.

## Repository layout

```
.
├── main.tex                 # Paper — abstract and extended version
├── bibliography.bib         # References
├── LICENSE                  # MIT — applies to all source code
├── LICENSE-PAPER            # CC BY 4.0 — applies to the paper content only
├── .env.example             # Copy to .env to configure the tool
└── entranceAnalyser/
    ├── backend/             # Rust backend (axum) — Postgres + PostGIS persistence
    └── frontend/            # React + Vite + MapLibre GL frontend
```

## Paper

The paper is a standard LaTeX project. Overleaf is connected to the
`chairemobilite/stateofthemap2026` remote and pushes to `main`. Local builds
work with any modern TeX Live distribution:

```bash
latexmk -pdf main.tex
```

## Entrance Analyser tool

The tool draws inhabited bounding boxes from a pre-computed GHS-POP
grid stored in PostgreSQL (configurable cell size, 1–100 km, default
10), shows them on a MapLibre map with togglable basemaps, and
persists kept candidates plus downstream analyses to the same
database. Each candidate is decorated with its total population,
density per km², and density relative to the densest cell in the
world.

### Quickstart

Prerequisites: Rust stable (1.90+), Node.js 22+, Yarn 1.x, and a
running **PostgreSQL 14+** instance with the **PostGIS** extension
available (Postgres.app, `brew install postgis`, or the
`postgis/postgis` Docker image all work). Copy `.env.example` to
`.env` and tweak the port/user if needed, then:

```bash
createdb entrance_analyser        # matches $PG_DATABASE
createdb entrance_analyser_test   # matches $PG_DATABASE_TEST
cd entranceAnalyser
cargo test                        # runs migrations in a disposable DB per test
cd frontend && yarn test
```

The runbook (downloading GHS-POP, building the grid, starting the
backend + Vite dev server) lives in
[`entranceAnalyser/README.md`](entranceAnalyser/README.md).

### Configuration

Copy `.env.example` to `.env` at the repository root and fill in the values
you need. All variables are optional for the scaffold, but some features
require them (for example, Bing Aerial basemap needs `VITE_BING_API_KEY`).

## Licences

- **Code** (everything under `entranceAnalyser/`, `.github/`, configuration
  files): MIT — see [LICENSE](LICENSE).
- **Paper** (`main.tex`, `bibliography.bib`, generated PDF): CC BY 4.0 — see
  [LICENSE-PAPER](LICENSE-PAPER).
