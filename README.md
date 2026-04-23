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
    ├── backend/             # Rust backend (axum)
    ├── frontend/            # React + Vite + MapLibre GL frontend
    └── data/                # Local JSON storage (gitignored)
```

## Paper

The paper is a standard LaTeX project. Overleaf is connected to the
`chairemobilite/stateofthemap2026` remote and pushes to `main`. Local builds
work with any modern TeX Live distribution:

```bash
latexmk -pdf main.tex
```

## Entrance Analyser tool

The tool generates random 10 × 10 km bounding boxes, optionally pre-filtered
by population density (GHS-POP from the JRC), and displays them on a MapLibre
map with togglable basemaps. The user keeps or rejects each candidate; kept
bounding boxes are persisted to `entranceAnalyser/data/kept_bboxes.json`.

### Quickstart

Prerequisites: Rust stable (1.90+), Node.js 22+.

```bash
# Backend
cd entranceAnalyser
cargo check
cargo test

# Frontend
cd frontend
npm install
npm run build   # production build
npm run dev     # local dev server
```

The backend runs on `127.0.0.1:3000`, the frontend dev server on
`127.0.0.1:5173` (Vite default). See `entranceAnalyser/README.md` (added in
PR 2) for the full runbook.

### Configuration

Copy `.env.example` to `.env` at the repository root and fill in the values
you need. All variables are optional for the scaffold, but some features
require them (for example, Bing Aerial basemap needs `VITE_BING_API_KEY`).

## Licences

- **Code** (everything under `entranceAnalyser/`, `.github/`, configuration
  files): MIT — see [LICENSE](LICENSE).
- **Paper** (`main.tex`, `bibliography.bib`, generated PDF): CC BY 4.0 — see
  [LICENSE-PAPER](LICENSE-PAPER).
