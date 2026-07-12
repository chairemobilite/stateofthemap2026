-- Copyright Polytechnique Montreal and contributors
--
-- This file is licensed under the MIT License.
-- License text available at https://opensource.org/licenses/MIT

-- Raw measurement endpoints per kept POI (one row per saved polyline).
-- Use this to inspect or export endpoints; the Haversine mismatch
-- logic (latest row per measurement_type × entrance_type, pairwise
-- comparison; default 10 m match radius, overridable via
-- MEASUREMENT_DESTINATION_MATCH_RADIUS_M) is implemented in the backend and exposed as:
--
--   GET http://127.0.0.1:3000/api/analyses/poi_focus_measurement_destination_warnings
--
-- Example (with jq):
--
--   curl -s http://127.0.0.1:3000/api/analyses/poi_focus_measurement_destination_warnings \
--     | jq '.warnings[] | {bbox_id, warnings}'
--
-- Response shape:
--   { "warnings": [ { "bbox_id": "<uuid>", "warnings": ["The nearest …", …] }, … ] }
-- Only POIs with at least one warning are included.

SELECT
    m.bbox_id,
    m.measurement_type,
    m.entrance_type,
    (m.coordinates -> (jsonb_array_length(m.coordinates) - 1) ->> 0)::double precision AS endpoint_lon,
    (m.coordinates -> (jsonb_array_length(m.coordinates) - 1) ->> 1)::double precision AS endpoint_lat,
    m.created_at
FROM poi_focus_measurements AS m
ORDER BY m.bbox_id, m.measurement_type, m.entrance_type, m.created_at;
