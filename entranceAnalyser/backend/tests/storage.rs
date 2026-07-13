/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Integration tests for `PgStore`: round-trip kept bboxes and check the
//! analyses side-table upsert semantics.

mod common;

use entrance_analyser_backend::bbox::{Bbox, CandidateSource};
use entrance_analyser_backend::poi_focus::{
    Feature, FeatureCollection, FeatureCollectionType, FeatureType, Geometry, PoiFocusResult,
};
use entrance_analyser_backend::focus_measurements::{
    path_length_m_haversine, EntranceKind, MeasurementPurpose, MeasurementStartOrigin,
    PoiFocusMeasurementStats,
};
use entrance_analyser_backend::storage::PgStore;
use serde_json::json;
use std::collections::BTreeMap;
use uuid::Uuid;

fn sample_bbox(center: [f64; 2]) -> Bbox {
    let [lon, lat] = center;
    Bbox {
        id: Uuid::new_v4(),
        west: lon - 0.05,
        south: lat - 0.05,
        east: lon + 0.05,
        north: lat + 0.05,
        center,
        cell_size_km: 10,
        population: 12_500.0,
        density_per_km2: 125.0,
        max_density_ratio: 0.25,
        built_volume: 750_000.0,
        max_built_volume_ratio: 0.3,
        candidate_source: CandidateSource::Random,
        custom_osm_type: None,
        custom_osm_id: None,
    }
}

#[tokio::test]
async fn append_then_load_roundtrip() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());

    let a = sample_bbox([-73.55, 45.55]);
    let b = sample_bbox([2.35, 48.85]);
    assert_eq!(store.append(a.clone()).await.unwrap(), 1);
    assert_eq!(store.append(b.clone()).await.unwrap(), 2);

    let kept = store.load().await.unwrap();
    assert_eq!(kept.len(), 2);
    // Load order is insertion order (kept_at ASC, id ASC).
    assert_eq!(kept[0].bbox, a);
    assert_eq!(kept[1].bbox, b);
    db.cleanup().await.ok();
}

#[tokio::test]
async fn append_round_trips_custom_candidate_source() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());
    let mut b = sample_bbox([-10.0, 20.0]);
    b.candidate_source = CandidateSource::CustomCentroid;
    store.append(b.clone()).await.unwrap();
    let kept = store.load().await.unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].bbox.candidate_source, CandidateSource::CustomCentroid);
    db.cleanup().await.ok();
}

#[tokio::test]
async fn count_reflects_rejects_as_noop() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());
    assert_eq!(store.count().await.unwrap(), 0);
    store.append(sample_bbox([0.0, 0.0])).await.unwrap();
    assert_eq!(store.count().await.unwrap(), 1);
    db.cleanup().await.ok();
}

#[tokio::test]
async fn record_analysis_upserts_by_bbox_and_kind() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());
    let bbox = sample_bbox([0.0, 0.0]);
    let id = bbox.id;
    store.append(bbox).await.unwrap();

    store
        .record_analysis(
            id,
            "entrance_count",
            Some(42.0),
            Some(json!({"confidence": 0.8})),
        )
        .await
        .unwrap();
    // Same (bbox_id, kind) upserts in place.
    store
        .record_analysis(id, "entrance_count", Some(43.0), None)
        .await
        .unwrap();
    // A different `kind` is a separate row.
    store
        .record_analysis(id, "building_count", Some(100.0), None)
        .await
        .unwrap();

    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM analyses WHERE bbox_id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        n, 2,
        "upsert must not duplicate rows on the same (bbox_id, kind)"
    );

    let v: Option<f64> = sqlx::query_scalar(
        "SELECT value FROM analyses WHERE bbox_id = $1 AND kind = 'entrance_count'",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(v, Some(43.0), "upsert must update the value in place");

    db.cleanup().await.ok();
}

#[tokio::test]
async fn poi_focus_round_trips_through_analyses() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());
    let bbox = sample_bbox([-73.55, 45.55]);
    let id = bbox.id;
    store.append(bbox).await.unwrap();

    let entrance_props = BTreeMap::from([("entrance".to_string(), "main".to_string())]);
    let focus = PoiFocusResult {
        center: [-73.55, 45.55],
        radius_m: 150,
        buildings: FeatureCollection {
            kind: FeatureCollectionType::FeatureCollection,
            features: vec![Feature {
                kind: FeatureType::Feature,
                id: "way/1".into(),
                geometry: Geometry::Polygon {
                    coordinates: vec![vec![[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [0.0, 0.0]]],
                },
                properties: BTreeMap::new(),
            }],
        },
        entrances: FeatureCollection {
            kind: FeatureCollectionType::FeatureCollection,
            features: vec![Feature {
                kind: FeatureType::Feature,
                id: "node/2".into(),
                geometry: Geometry::Point {
                    coordinates: [-73.55, 45.55],
                },
                properties: entrance_props.clone(),
            }],
        },
    };

    store.write_poi_focus(id, &focus).await.unwrap();

    let round_tripped = store
        .read_poi_focus(id)
        .await
        .unwrap()
        .expect("written row must be readable");
    assert_eq!(round_tripped.radius_m, 150);
    assert_eq!(round_tripped.buildings.features.len(), 1);
    assert_eq!(round_tripped.buildings.features[0].id, "way/1");
    assert_eq!(round_tripped.entrances.features.len(), 1);
    assert_eq!(
        round_tripped.entrances.features[0].properties,
        entrance_props,
    );

    // Re-write with a different radius: same (bbox_id, kind) row must
    // upsert in place rather than duplicate.
    let mut updated = focus.clone();
    updated.radius_m = 250;
    store.write_poi_focus(id, &updated).await.unwrap();
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM analyses WHERE bbox_id = $1 AND kind = 'poi_focus'",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(n, 1, "poi_focus must upsert in place");
    let after = store.read_poi_focus(id).await.unwrap().unwrap();
    assert_eq!(after.radius_m, 250);

    // Bulk endpoint surfaces the same row, keyed by bbox id.
    let all = store.read_all_poi_focuses().await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].0, id);
    assert_eq!(all[0].1.radius_m, 250);

    // Unknown bbox id reads back as None.
    assert!(store
        .read_poi_focus(Uuid::new_v4())
        .await
        .unwrap()
        .is_none());

    db.cleanup().await.ok();
}

#[tokio::test]
async fn poi_focus_measurements_crud_round_trip() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());
    let bbox = sample_bbox([0.0, 0.0]);
    let id = bbox.id;
    store.append(bbox).await.unwrap();

    let coords: [[f64; 2]; 2] = [[0.0, 0.0], [0.001, 0.0]];
    let length_m = path_length_m_haversine(&coords).unwrap();
    let m = store
        .insert_poi_focus_measurement(
            id,
            &coords,
            5.0,
            length_m,
            MeasurementPurpose::ToNearestWalkingNetwork,
            EntranceKind::Main,
            MeasurementStartOrigin::PoiFocusCentroid,
            None,
        )
        .await
        .unwrap();
    assert_eq!(m.bbox_id, id);
    assert_eq!(m.coordinates.len(), 2);
    assert_eq!(
        m.measurement_type,
        MeasurementPurpose::ToNearestWalkingNetwork
    );
    assert_eq!(m.entrance_type, EntranceKind::Main);
    assert_eq!(m.start_origin, MeasurementStartOrigin::PoiFocusCentroid);
    assert!(m.start_osm_node_id.is_none());

    let list = store.list_poi_focus_measurements(id).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, m.id);

    let coords2 = vec![[0.0_f64, 0.0_f64], [0.002, 0.0_f64]];
    let len2 = path_length_m_haversine(&coords2).unwrap();
    let updated = store
        .update_poi_focus_measurement(
            id,
            m.id,
            &coords2,
            4.0,
            len2,
            MeasurementPurpose::ToNearestMainEntrance,
            EntranceKind::CentroidMainBuilding,
            MeasurementStartOrigin::OsmEntrance,
            Some(99_001),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.length_m, len2);
    assert_eq!(
        updated.measurement_type,
        MeasurementPurpose::ToNearestMainEntrance
    );
    assert_eq!(updated.entrance_type, EntranceKind::CentroidMainBuilding);
    assert_eq!(updated.start_origin, MeasurementStartOrigin::OsmEntrance);
    assert_eq!(updated.start_osm_node_id, Some(99_001));

    assert!(store.delete_poi_focus_measurement(id, m.id).await.unwrap());
    assert!(!store
        .delete_poi_focus_measurement(id, m.id)
        .await
        .unwrap());
    assert!(store.list_poi_focus_measurements(id).await.unwrap().is_empty());

    db.cleanup().await.ok();
}

#[tokio::test]
async fn poi_focus_measurement_stats_groups_pairs_with_median_length_and_duration() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());
    let bbox = sample_bbox([0.0, 0.0]);
    let id = bbox.id;
    store.append(bbox).await.unwrap();

    let seg = |dx: f64| vec![[0.0_f64, 0.0_f64], [dx, 0.0_f64]];
    let len = |dx: f64| path_length_m_haversine(&seg(dx)).unwrap();

    store
        .insert_poi_focus_measurement(
            id,
            &seg(0.001),
            5.0,
            len(0.001),
            MeasurementPurpose::ToNearestEntrance,
            EntranceKind::Main,
            MeasurementStartOrigin::PoiFocusCentroid,
            None,
        )
        .await
        .unwrap();
    store
        .insert_poi_focus_measurement(
            id,
            &seg(0.003),
            5.0,
            len(0.003),
            MeasurementPurpose::ToNearestEntrance,
            EntranceKind::Main,
            MeasurementStartOrigin::OsmEntrance,
            Some(1),
        )
        .await
        .unwrap();

    let stats: PoiFocusMeasurementStats = store
        .aggregate_poi_focus_measurement_pair_stats(10.0)
        .await
        .unwrap();
    let row = stats
        .by_measurement_type_and_entrance_type
        .iter()
        .find(|r| {
            r.attr_a == "to_nearest_entrance"
                && r.attr_b == "main"
                && r.n == 2
        })
        .expect("one grouped row for entrance+main");
    assert!((row.length_m.median - (len(0.001) as f64 + len(0.003) as f64) / 2.0).abs() < 1.0);
    let d0 = len(0.001) as f64 * 3600.0 / (1000.0 * 5.0);
    let d1 = len(0.003) as f64 * 3600.0 / (1000.0 * 5.0);
    assert!((row.duration_s.median - (d0 + d1) / 2.0).abs() < 1.0);

    db.cleanup().await.ok();
}

#[tokio::test]
async fn measurement_stats_pair_main_entrance_with_any_centroid_kind() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());
    let bbox = sample_bbox([0.0, 0.0]);
    let id = bbox.id;
    store.append(bbox).await.unwrap();

    let seg = |dx: f64| vec![[0.0_f64, 0.0_f64], [dx, 0.0_f64]];
    let len = |dx: f64| path_length_m_haversine(&seg(dx)).unwrap();

    // Same POI, same measurement type: one main-entrance walk plus two
    // different centroid kinds → two (main, centroid) pairs. The
    // entrance-targeting type below must be excluded from the deltas.
    let rows = [
        (0.001, MeasurementPurpose::ToNearestTransitStop, EntranceKind::Main),
        (0.002, MeasurementPurpose::ToNearestTransitStop, EntranceKind::CentroidMainBuilding),
        (0.004, MeasurementPurpose::ToNearestTransitStop, EntranceKind::CentroidArea),
        (0.001, MeasurementPurpose::ToNearestEntrance, EntranceKind::Main),
        (0.002, MeasurementPurpose::ToNearestEntrance, EntranceKind::CentroidParcel),
        // The two retired driving combos fold into to_nearest_driving_road
        // in every stat, so this main/centroid pair must match up.
        (0.001, MeasurementPurpose::ToNearestWalkingDrivingNetwork, EntranceKind::Main),
        (
            0.003,
            MeasurementPurpose::ToNearestWalkingCyclingDrivingNetwork,
            EntranceKind::CentroidMainBuilding,
        ),
    ];
    for (dx, purpose, entrance) in rows {
        store
            .insert_poi_focus_measurement(
                id,
                &seg(dx),
                5.0,
                len(dx),
                purpose,
                entrance,
                MeasurementStartOrigin::PoiFocusCentroid,
                None,
            )
            .await
            .unwrap();
    }

    let stats = store.aggregate_poi_focus_measurement_pair_stats(10.0).await.unwrap();
    let types: Vec<&str> = stats
        .main_entrance_vs_centroid
        .iter()
        .map(|r| r.measurement_type.as_str())
        .collect();
    assert_eq!(
        types,
        ["to_nearest_driving_road", "to_nearest_transit_stop"],
        "entrance targets excluded; driving combos folded into driving_road"
    );
    let driving = &stats.main_entrance_vs_centroid[0];
    assert_eq!(driving.n, 1, "combo main pairs with combo centroid after folding");
    assert!((driving.delta_length_m.avg - (len(0.003) - len(0.001)) as f64).abs() < 1.0);
    // Pair buckets fold the same way: no retired combo type remains.
    assert!(stats
        .by_measurement_type_and_entrance_type
        .iter()
        .all(|r| !r.attr_a.contains("walking_driving") && !r.attr_a.contains("cycling_driving")));
    // Endpoint agreement: every centroid endpoint here is > 10 m from the
    // main endpoint of the same (folded) type, so all pairs mismatch.
    let endpoints = &stats.main_entrance_vs_centroid_endpoints;
    let by_type = |t: &str| endpoints.iter().find(|r| r.measurement_type == t).unwrap();
    assert_eq!(by_type("to_nearest_driving_road").n_pairs, 1);
    assert_eq!(by_type("to_nearest_driving_road").n_mismatch, 1);
    assert_eq!(by_type("to_nearest_transit_stop").n_pairs, 2);
    assert_eq!(by_type("to_nearest_transit_stop").n_mismatch, 2);

    let row = &stats.main_entrance_vs_centroid[1];
    assert_eq!(row.measurement_type, "to_nearest_transit_stop");
    assert_eq!(row.n, 2);
    let d_small = (len(0.002) - len(0.001)) as f64;
    let d_big = (len(0.004) - len(0.001)) as f64;
    assert!((row.delta_length_m.min - d_small).abs() < 1.0);
    assert!((row.delta_length_m.max - d_big).abs() < 1.0);
    assert!((row.delta_length_m.median - (d_small + d_big) / 2.0).abs() < 1.0);
    // Same walking speed everywhere: duration delta = length delta × 3600 / 5000.
    assert!((row.delta_duration_s.max - d_big * 3600.0 / 5000.0).abs() < 1.0);

    db.cleanup().await.ok();
}

#[tokio::test]
async fn poi_focus_measurement_destination_warnings_groups_by_bbox() {
    use entrance_analyser_backend::focus_measurements::{
        EntranceKind, MeasurementPurpose, MeasurementStartOrigin,
    };

    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());
    let bbox_a = sample_bbox([0.0, 0.0]);
    let bbox_b = sample_bbox([1.0, 1.0]);
    let id_a = bbox_a.id;
    let id_b = bbox_b.id;
    store.append(bbox_a).await.unwrap();
    store.append(bbox_b).await.unwrap();

    let seg = |dx: f64| vec![[0.0_f64, 0.0_f64], [dx, 0.0_f64]];
    let len = |dx: f64| path_length_m_haversine(&seg(dx)).unwrap();

    store
        .insert_poi_focus_measurement(
            id_a,
            &seg(0.001),
            5.0,
            len(0.001),
            MeasurementPurpose::ToNearestTransitStop,
            EntranceKind::Main,
            MeasurementStartOrigin::OsmEntrance,
            Some(1),
        )
        .await
        .unwrap();
    store
        .insert_poi_focus_measurement(
            id_a,
            &seg(0.01),
            5.0,
            len(0.01),
            MeasurementPurpose::ToNearestTransitStop,
            EntranceKind::CentroidMainBuilding,
            MeasurementStartOrigin::BuildingCentroid,
            Some(2),
        )
        .await
        .unwrap();
    store
        .insert_poi_focus_measurement(
            id_b,
            &seg(0.001),
            5.0,
            len(0.001),
            MeasurementPurpose::ToNearestTransitStop,
            EntranceKind::Main,
            MeasurementStartOrigin::OsmEntrance,
            Some(3),
        )
        .await
        .unwrap();
    store
        .insert_poi_focus_measurement(
            id_b,
            &seg(0.00101),
            5.0,
            len(0.00101),
            MeasurementPurpose::ToNearestTransitStop,
            EntranceKind::CentroidMainBuilding,
            MeasurementStartOrigin::BuildingCentroid,
            Some(4),
        )
        .await
        .unwrap();

    let body = store
        .poi_focus_measurement_destination_warnings(10.0)
        .await
        .unwrap();
    assert_eq!(body.warnings.len(), 1);
    assert_eq!(body.warnings[0].bbox_id, id_a);
    assert_eq!(body.warnings[0].warnings.len(), 1);
    assert!(body.warnings[0].warnings[0].contains("transit stop"));

    db.cleanup().await.ok();
}

#[tokio::test]
async fn poi_pick_country_stats_counts_by_country_with_quebec_subset() {
    use entrance_analyser_backend::overpass::{OsmType, Poi};

    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());

    // Synthetic rectangles instead of real Natural Earth data: one fake
    // country "AA", Canada around the St-Lawrence, and a Quebec region
    // polygon nested inside Canada.
    for (level, iso, name, wkt) in [
        ("country", "AA", "Alphaland", "MULTIPOLYGON(((0 0, 10 0, 10 10, 0 10, 0 0)))"),
        ("country", "CA", "Canada", "MULTIPOLYGON(((-80 40, -60 40, -60 50, -80 50, -80 40)))"),
        ("region", "CA-QC", "Québec", "MULTIPOLYGON(((-75 44, -70 44, -70 47, -75 47, -75 44)))"),
    ] {
        sqlx::query(
            "INSERT INTO admin_boundaries (level, iso_code, name, geom) \
             VALUES ($1, $2, $3, ST_GeomFromText($4, 4326))",
        )
        .bind(level)
        .bind(iso)
        .bind(name)
        .bind(wkt)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    let poi_at = |center: [f64; 2]| Poi {
        osm_type: OsmType::Node,
        osm_id: 1,
        center,
        tags: BTreeMap::new(),
        group: "shop".into(),
    };
    // (POI center, rejected): Alphaland; Canada in Quebec (rejected);
    // Canada outside Quebec; middle of the Pacific (unresolved).
    for (center, rejected) in [
        ([5.0, 5.0], false),
        ([-73.55, 45.55], true),
        ([-65.0, 42.0], false),
        ([-150.0, 0.0], false),
    ] {
        let bbox = sample_bbox(center);
        let id = bbox.id;
        store.append(bbox).await.unwrap();
        store.write_poi_pick(id, Some(&poi_at(center))).await.unwrap();
        if rejected {
            store
                .set_poi_pick_rejection(
                    id,
                    Some(entrance_analyser_backend::storage::PoiRejectionReason::Obsolete),
                )
                .await
                .unwrap();
        }
    }
    // A cached "no POI in this cell" row must not count.
    let empty = sample_bbox([5.0, 6.0]);
    let empty_id = empty.id;
    store.append(empty).await.unwrap();
    store.write_poi_pick(empty_id, None).await.unwrap();

    let stats = store.aggregate_poi_pick_country_stats().await.unwrap();
    assert_eq!(stats.total, 4);
    assert_eq!(stats.unresolved, 1);
    // Sorted by n descending, then name.
    assert_eq!(stats.by_country.len(), 2);
    assert_eq!(stats.by_country[0].iso_code, "CA");
    assert_eq!(stats.by_country[0].n, 2);
    assert_eq!(stats.by_country[0].n_in_quebec, 1);
    assert_eq!(stats.by_country[0].n_rejected, 1);
    assert_eq!(stats.by_country[1].iso_code, "AA");
    assert_eq!(stats.by_country[1].n, 1);
    assert_eq!(stats.by_country[1].n_in_quebec, 0);
    assert_eq!(stats.by_country[1].n_rejected, 0);

    db.cleanup().await.ok();
}

#[tokio::test]
async fn append_writes_a_valid_postgis_polygon() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());
    let bbox = sample_bbox([10.0, 20.0]);
    let id = bbox.id;
    store.append(bbox).await.unwrap();

    let (srid, gtype, area_gt_0): (i32, String, bool) = sqlx::query_as(
        "SELECT ST_SRID(geom), GeometryType(geom), ST_Area(geom) > 0 \
         FROM kept_bboxes WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(srid, 4326);
    assert_eq!(gtype, "POLYGON");
    assert!(area_gt_0);

    db.cleanup().await.ok();
}
