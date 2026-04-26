# Entrance Analyser

Sampling tool used to gather candidate sites for the OSM Science 2026
analysis of building-entrance mapping. Pulls inhabited areas from a
pre-computed GHS-POP grid (optionally enriched with GHS-BUILT-V built
volume) stored in PostgreSQL, draws them on a MapLibre map with
togglable basemaps, and persists the operator's keep / reject
decisions — along with downstream per-bbox analyses — in the same
database.

## Architecture

```
backend/   Rust (axum) + sqlx — Postgres/PostGIS persistence
           migrations/0001_init.sql                schema (grid + kept_bboxes + analyses)
           migrations/0002_grid_built_volume.sql   built_volume + grid_meta totals
           migrations/0003_kept_bboxes_built_volume.sql   built context on kept rows
           src/config.rs                           PG_* env → database URL
           src/db.rs                               pool factory + embedded migrator
           src/sampler.rs                          uniform/population/built/blended draws
           src/storage.rs                          PgStore: kept_bboxes + analyses
           src/poi_config.rs                       poi_tags.yml loader (groups + exceptions)
           src/overpass.rs                         Overpass QL client + result decoder
           src/poi_focus.rs                        focus-map fetcher (buildings + entrances)
           src/bin/build_grid.rs                   offline aggregation tool
config/    Runtime config consumed by the analysis pipeline
           poi_tags.yml                            POI tag groups + exceptions
frontend/  React + Vite + MapLibre GL — three screens:
           src/                                    Sampling screen (keep/reject + strategy)
           src/useAppConfig.ts                     Hook fetching runtime config (OSM editor URL, focus radius)
           src/keptBboxes/                         Kept-bboxes overview map + popup + POI picker
           src/keptBboxes/PoiFocusMap.tsx          Focus map (buildings + entrances around picked POI)
           src/keptBboxes/usePoiFocus.ts           Hook owning the focus state (bulk hydrate + POST)
           src/keptBboxes/poiFocusGeoJson.ts       Pure helpers: buffer ring + collection casts
           src/keptBboxes/MapContextMenu.tsx       Right-click "open in …" menu (presentational)
           src/keptBboxes/mapLinks.ts              URL builders for 7 map services + OSM editor template
           src/keptBboxes/chinaCoords.ts           WGS84 → GCJ-02 → BD09 datum conversion (China)
```

The HTTP backend serves these endpoints:

| Method | Path                                        | Purpose                                                          |
|--------|---------------------------------------------|------------------------------------------------------------------|
| GET    | `/api/bbox/random?strategy=…&alpha=…`       | draw a candidate under the given strategy (see below)            |
| POST   | `/api/bbox/decision`                        | keep or reject a previously drawn bbox (client echoes it back)   |
| GET    | `/api/bbox/kept`                            | list every persisted kept bbox                                   |
| POST   | `/api/bbox/kept/:id/poi_pick`               | pick (and cache) one POI inside a kept bbox via Overpass         |
| GET    | `/api/analyses/poi_picks`                   | list every cached POI pick, in insertion order                   |
| POST   | `/api/bbox/kept/:id/poi_focus`              | fetch (and cache) buildings + entrances around the picked POI    |
| GET    | `/api/analyses/poi_focuses`                 | list every cached focus result, in insertion order               |
| GET    | `/api/config`                               | runtime config echoed to the frontend (OSM editor URL, …)        |

### Sampling strategies

`?strategy=` controls how `/api/bbox/random` weights the draw. Default
is `blended` with `α=0.5`.

| Strategy     | Weight per cell                                          | When to use                                                |
|--------------|----------------------------------------------------------|------------------------------------------------------------|
| `uniform`    | 1                                                        | diagnostic baseline — every inhabited cell equally likely  |
| `population` | `pop_i`                                                  | hit where people live (standard OD / accessibility view)   |
| `built`      | `built_i`                                                | rescue industrial / port / campus blocks with few residents |
| `blended`    | `α · built_i / Σ built + (1-α) · pop_i / Σ pop`          | recommended: both signals, per-draw 50/50 at α=0.5         |

Under the hood each non-uniform strategy runs
**Efraimidis–Spirakis weighted reservoir sampling** in log space —
`ORDER BY ln(1 - random()) / weight DESC LIMIT 1`. That's the
numerically stable, monotonically-equivalent form of
`random() ^ (1 / weight) DESC`: at our scale normalised weights are
`O(1e-9)` per cell, so `1 / weight ≈ 1e9` and `random() ^ 1e9`
underflows `double precision` for every row (Postgres raises
`value out of range: underflow`). `built` and `blended` need a grid
built with `--built-volume`; if the column is all-zero the backend
returns 503 with a rebuild hint instead of silently returning uniform
draws.

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

### 2. Download the source rasters

[GHS-POP R2023A][ghs] — 2020 epoch, 1 km Mollweide (EPSG:54009),
~322 MB zipped. The companion [GHS-BUILT-V R2023A][ghs-built] uses the
exact same grid and adds per-cell built volume (m³) so the sampler can
find industrial / port / campus blocks that host few residents:

```bash
curl -O 'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/GHS_POP_E2020_GLOBE_R2023A_54009_1000/V1-0/GHS_POP_E2020_GLOBE_R2023A_54009_1000_V1_0.zip'
unzip GHS_POP_E2020_GLOBE_R2023A_54009_1000_V1_0.zip

curl -O 'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_BUILT_V_GLOBE_R2023A/GHS_BUILT_V_E2020_GLOBE_R2023A_54009_1000/V1-0/GHS_BUILT_V_E2020_GLOBE_R2023A_54009_1000_V1_0.zip'
unzip GHS_BUILT_V_E2020_GLOBE_R2023A_54009_1000_V1_0.zip
```

You only need the `.tif`s; the rest of each archive is metadata. The
built-volume file is optional: build-grid works with just GHS-POP, but
then the `built` and `blended` sampling strategies return 503 until
you rebuild with both.

> **Citations** (both CC BY 4.0):
> Schiavina, M., Freire, S., MacManus, K. (2023): GHS-POP R2023A — GHS
> population grid multitemporal (1975–2030). European Commission, Joint
> Research Centre (JRC). DOI: [10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE](https://doi.org/10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE)
>
> Pesaresi, M., Politis, P. (2023): GHS-BUILT-V R2023A — GHS built-up
> volume grid multitemporal (1975–2030). European Commission, Joint
> Research Centre (JRC). DOI: [10.2905/AB2F107A-03CD-47A3-85E5-139D8EC63283](https://doi.org/10.2905/AB2F107A-03CD-47A3-85E5-139D8EC63283)

### 3. Aggregate into the grid tables

```bash
cd entranceAnalyser
cargo run --release --bin entrance-analyser-build-grid -- \
    --input        /path/to/GHS_POP_E2020_GLOBE_R2023A_54009_1000_V1_0.tif \
    --built-volume /path/to/GHS_BUILT_V_E2020_GLOBE_R2023A_54009_1000_V1_0.tif \
    --cell-size-km 10
```

`--built-volume` is optional; omit it for a pop-only grid. Both
rasters are read in lock-step and a super-cell survives if either
signal crosses its `--min-population` / `--min-built-volume`
threshold (defaults `0.5` / `0.5`) — so purely-industrial cells land
in the grid even with zero residents.

Each raster's `GDAL_NODATA` sentinel (tag 42113) is read from the
TIFF header and pixels matching it are skipped *before* being cast
to `f32`. This matters for GHS-BUILT-V, whose nodata value is
`0xFFFFFFFF` — if we let it through the cast, it rounds up to
exactly `2^32` and 100 ocean pixels sum to `4.3 × 10¹¹` m³ of
phantom built volume per 10 km cell, pulling the `built` / `blended`
samplers into the middle of the Pacific. See
[`backend/src/geotiff_pop.rs`](backend/src/geotiff_pop.rs) →
`decoding_to_f32` for the filter.

**LZW-compressed inputs are auto-transcoded.** The `tiff = 0.11`
crate's LZW decoder dies mid-raster on strips without an explicit
end-of-information code (GHS-BUILT-V ships exactly that way). To
avoid forking `weezl`, `build-grid` detects LZW compression from
the TIFF header and shells out to `gdal_translate -co COMPRESS=NONE`
to produce a cached sibling at
`<original>.uncompressed.tif`. Subsequent runs reuse the sibling
(mtime-checked), so you pay the ~30 s re-encode cost once per
raster. Requires `gdal_translate` on `$PATH` — install GDAL
(`brew install gdal` / `apt-get install gdal-bin`) if the command
fails with `gdal_translate not found`.

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

The UI has three screens. The `Sampling` and `Kept bboxes` tabs sit
at the top of the viewport; `Focus` is reached from the popup of any
kept bbox that already has a picked POI:

| Screen         | What it does                                                                                                        |
|----------------|---------------------------------------------------------------------------------------------------------------------|
| `Sampling`     | Draw a candidate bbox, keep or reject it, and watch it land on the MapLibre map.                                    |
| `Kept bboxes`  | World-overview map of every row in `kept_bboxes`: circle markers below zoom 6, filled rectangles above, popup on click. The popup hosts a **Pick POI** button that runs the Overpass picker on demand; picked features paint as orange dots. |
| `Focus`        | Zoom-in map anchored on one picked POI: building polygons, entrance markers, and a dashed buffer ring at the server-config radius. Reached via the **Open focus map** button in the popup; **Back** returns to the overview. |

The `Kept bboxes` map uses a single GeoJSON source per geometry type
(polygons for the rectangles, points for the low-zoom markers) so the
visible layer swaps without reloading data. Clicking any feature opens
a MapLibre popup whose body is a React-rendered `KeptBboxRow`
(headline info + `Not started` progress pill). The full
`ProgressStatus` union (`not_started` / `queued` / `running` / `done`
/ `failed`) and its pill styles are defined up front in
[`frontend/src/keptBboxes/progress.ts`](frontend/src/keptBboxes/progress.ts),
so the forthcoming analysis runner can flip pills without touching
any component that displays them.

## POI picker

The kept-bboxes view exposes a per-cell **Pick POI** action that
queries Overpass for every feature matching
[`config/poi_tags.yml`](config/poi_tags.yml), drops anything
matched by an `exceptions` rule, and selects exactly one feature
uniformly at random across all surviving groups. The picked POI
(or `null` when the cell is genuinely empty) is cached in the
`analyses` table with `kind='poi_pick'` so subsequent calls
short-circuit without re-querying Overpass.

`config/poi_tags.yml` has two top-level keys:

- `groups` — named semantic categories (`shops`, `amenities`, …)
  whose values are lists of OSM tag expressions (`key=value`, with
  `*` as a wildcard).
- `exceptions` — OSM tag expressions that disqualify a feature
  even when it would otherwise match a group (e.g.
  `amenity=parking`, `building=garage`). Applied after group
  matching so a bakery tagged with one of the excluded sub-keys is
  filtered out at query time.

The Overpass endpoint is configurable via the `OVERPASS_URL`
environment variable; it defaults to the public
`https://overpass-api.de/api/interpreter` when unset. Operators
running heavy batches should point this at a self-hosted mirror or
a community alternate.

## POI focus map

Once a POI has been picked for a kept cell, `POST
/api/bbox/kept/:id/poi_focus` queries Overpass a second time for
every `way[building]` and `node[entrance]` within an `around:`
buffer of the picked feature, and returns them as two GeoJSON
`FeatureCollection`s — ready to drop into MapLibre `geojson`
sources. The result is cached in `analyses` with `kind='poi_focus'`
so the next click is instant.

Scope decisions, all reversible without schema changes:

- **Ways for buildings, not relations.** Multipolygon `building`
  relations are rare and decoding their `out geom` members is
  significantly more involved; the first cut under-counts them
  intentionally. _Known limitation: a focus map will quietly miss
  any building mapped as a multipolygon, even with `building=yes`._
  Lifting this means querying `relation[building][type=multipolygon]`
  alongside the way query and assembling the outer ring(s) from
  `out geom`'s `members` array.
- **`entrance=*` nodes only**, not `door=*`. The mapping question
  is whether buildings have *entrances* mapped, not whether
  interior doors carry a tag.
- **Buffer radius is per-request, with a server-side default.**
  `POI_FOCUS_RADIUS_M` (default `150`) is read once at startup and
  used when the caller omits the override. Clients can pass
  `?radius_m=N` (`[10, 2000]` m) to widen or shrink the buffer for
  one bbox at a time — the focus map's header form does exactly
  that. The single cached row per bbox is overwritten when the
  radius changes (latest-wins), and `payload.radius_m` always
  echoes the value the row was computed at.

The endpoint returns:

- `200 OK` with the focus result on success (cached or fresh).
- `400 Bad Request` if `?radius_m=` is outside `[10, 2000]`.
- `409 Conflict` if `/poi_pick` has not run for this bbox yet.
- `422 Unprocessable Entity` if `/poi_pick` ran but the cell was
  empty — there's no POI to anchor the focus map on.
- `502 Bad Gateway` if Overpass is unhealthy (matching `/poi_pick`).

On the frontend, [`usePoiFocus`](frontend/src/keptBboxes/usePoiFocus.ts)
mirrors `usePoiPicks` (`loading | idle | error` status, in-flight
set, injectable fetchers) and bulk-hydrates from
`/api/analyses/poi_focuses` on mount, so re-opening the same focus
map is instant. The popup's **Open focus map** button only renders
once a real POI is cached (i.e. not the empty-cell case), since the
Overpass `around:` filter needs a centre coordinate. Switching between
focus maps re-mounts [`PoiFocusMap`](frontend/src/keptBboxes/PoiFocusMap.tsx)
on `bbox.id` so the new buffer ring frames cleanly instead of
pan-animating across the world.

## Map context menu

Right-clicking anywhere on the focus map opens a menu of "open in …"
deeplinks for the click coordinates:

| Service             | Coverage notes                                                                       |
|---------------------|--------------------------------------------------------------------------------------|
| Mapillary           | global, OSM-friendly                                                                 |
| Panoramax           | France-centric; very thin elsewhere                                                  |
| KartaView           | global, sparse                                                                       |
| Google Street View  | most of the world; **blocked / no coverage in mainland China**                       |
| Baidu (百度地图)    | dominant inside mainland China; near-zero abroad                                     |
| AMap (高德地图)     | strong in mainland China; no coverage abroad                                         |
| Edit on OpenStreetMap | always — opens iD by default; configurable to JOSM / Rapid / etc. via env var      |

The menu is rendered by
[`MapContextMenu`](frontend/src/keptBboxes/MapContextMenu.tsx) and
populated by pure URL builders in
[`mapLinks.ts`](frontend/src/keptBboxes/mapLinks.ts). Every entry is
shown unconditionally — the user knows their cell better than we do —
but two things deserve flagging because they're easy to get wrong:

**1. China datum offset.** Chinese law requires consumer maps to
publish on **GCJ-02** ("Mars datum"), a non-linear ~50–700 m offset
of WGS84 that's applied by AMap, Tencent, Apple Maps in China, and
every 天地图-derived basemap. Baidu adds a second obfuscation
(**BD09**) on top. OSM stores everything in WGS84, so linking a raw
WGS84 lat/lon into Baidu or AMap silently lands the marker on the
wrong block. We convert client-side in
[`chinaCoords.ts`](frontend/src/keptBboxes/chinaCoords.ts) using the
canonical `coordtransform` algorithms (parametric tests cross-checked
against the `wandergis/coordtransform` Python reference and its
README example). Reverse conversions are not provided: GCJ-02 is
one-way by design and we don't need them for the menu.

**2. OSM editor URL is configurable.** The "Edit on OpenStreetMap"
entry uses a template string read from `OSM_EDITOR_URL` (env var,
default `https://www.openstreetmap.org/edit#map={zoom}/{lat}/{lon}`)
with `{lat}`, `{lon}`, and `{zoom}` placeholders substituted at
click time. Override the env var to swap iD for JOSM remote
control, RapiD, ID-mapcomplete, etc.:

```env
# JOSM remote control (edit a 50 m × 50 m box around the click)
OSM_EDITOR_URL=http://127.0.0.1:8111/load_and_zoom?left={lon}&right={lon}&top={lat}&bottom={lat}
```

The value is exposed to the frontend via `GET /api/config` rather
than a `VITE_*` build-time env var so changes take effect on
backend restart without rebuilding the frontend bundle. The
[`useAppConfig`](frontend/src/useAppConfig.ts) hook fetches it once
on mount; the `App` component falls back to the default template
while the request is in flight.

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

Uniform draws use `ORDER BY random() LIMIT 1`; the weighted strategies
use `ORDER BY ln(1 - random()) / weight DESC LIMIT 1` (log-space
Efraimidis–Spirakis — see the warning above the strategies table for
why the naive `^ (1 / weight)` form underflows). Both are full
seq-scans of `grid_cells` — at our scale (single-operator dev tool,
~800 k rows at 10 km with both rasters) that lands around 30–80 ms
per draw, comfortably under the human click loop.
If the workload ever becomes concurrent, cache a cumulative-sum column
+ index and binary-search against `random() · Σ weight` — that's a
one-query change in [`src/sampler.rs`](backend/src/sampler.rs).

[ghs]: https://human-settlement.emergency.copernicus.eu/ghs_pop2023.php
[ghs-built]: https://human-settlement.emergency.copernicus.eu/ghs_buV2023.php
