/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Loads and mutates persisted POI-focus measurement polylines for one bbox.

import { startTransition, useCallback, useEffect, useState } from 'react';

import {
    createPoiFocusMeasurement,
    deletePoiFocusMeasurement,
    fetchPoiFocusMeasurements,
    updatePoiFocusMeasurement,
    type PoiFocusMeasurement,
    type PoiFocusMeasurementWriteBody,
} from '../api';

export interface UsePoiFocusMeasurementsResult {
    measurements: PoiFocusMeasurement[];
    loading: boolean;
    error: string | null;
    reload: () => Promise<void>;
    create: (body: PoiFocusMeasurementWriteBody) => Promise<PoiFocusMeasurement>;
    update: (measureId: string, body: PoiFocusMeasurementWriteBody) => Promise<PoiFocusMeasurement>;
    remove: (measureId: string) => Promise<void>;
}

/**
 * Fetch all measurements for `bboxId` on mount and after each mutation.
 *
 * @param bboxId - Active kept bbox while the focus map is open; pass
 *                 `null` when no bbox is selected so hooks stay idle.
 */
export function usePoiFocusMeasurements(bboxId: string | null): UsePoiFocusMeasurementsResult {
    const [measurements, setMeasurements] = useState<PoiFocusMeasurement[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        if (!bboxId) {
            setMeasurements([]);
            setError(null);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const rows = await fetchPoiFocusMeasurements(bboxId);
            setMeasurements(rows);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [bboxId]);

    useEffect(() => {
        startTransition(() => {
            void reload();
        });
    }, [reload]);

    const create = useCallback(
        async (body: PoiFocusMeasurementWriteBody) => {
            if (!bboxId) throw new Error('no bbox id');
            const m = await createPoiFocusMeasurement(bboxId, body);
            setMeasurements((prev) => [...prev, m]);
            return m;
        },
        [bboxId],
    );

    const update = useCallback(
        async (measureId: string, body: PoiFocusMeasurementWriteBody) => {
            if (!bboxId) throw new Error('no bbox id');
            const m = await updatePoiFocusMeasurement(bboxId, measureId, body);
            setMeasurements((prev) => prev.map((row) => (row.id === measureId ? m : row)));
            return m;
        },
        [bboxId],
    );

    const remove = useCallback(
        async (measureId: string) => {
            if (!bboxId) throw new Error('no bbox id');
            await deletePoiFocusMeasurement(bboxId, measureId);
            setMeasurements((prev) => prev.filter((row) => row.id !== measureId));
        },
        [bboxId],
    );

    return { measurements, loading, error, reload, create, update, remove };
}
