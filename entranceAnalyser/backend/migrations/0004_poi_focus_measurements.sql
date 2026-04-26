-- Persisted polylines drawn in the POI focus map measurement tool (PR13+).
-- One bbox can have many lines; each row stores GeoJSON-style [lon, lat] pairs.

CREATE TABLE poi_focus_measurements (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bbox_id             UUID NOT NULL REFERENCES kept_bboxes (id) ON DELETE CASCADE,
    coordinates         JSONB NOT NULL,
    walking_speed_kmh   DOUBLE PRECISION NOT NULL,
    length_m            INTEGER NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT poi_focus_measurements_coords_is_array
        CHECK (jsonb_typeof(coordinates) = 'array'),
    CONSTRAINT poi_focus_measurements_speed_positive
        CHECK (walking_speed_kmh > 0::double precision),
    CONSTRAINT poi_focus_measurements_length_non_negative
        CHECK (length_m >= 0)
);

CREATE INDEX poi_focus_measurements_bbox_id_idx
    ON poi_focus_measurements (bbox_id);
