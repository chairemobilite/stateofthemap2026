//! Modal to load a sampling candidate bbox from lat/lon or from one OSM
//! node/way/relation (Overpass centre), without waiting on random draws.

import { useEffect, useId, useState, type FormEvent } from 'react';

import { parseLatLonPairInput } from './customCentroidParse';
import { parseOsmRef } from './customOsmRefParse';

export interface CustomCentroidModalProps {
    /** When false, children are not mounted in the accessibility tree. */
    open: boolean;
    onClose: () => void;
    /** Return `true` when the bbox was applied so the dialog may close. */
    onApplyLatLon: (lat: number, lon: number) => Promise<boolean>;
    onApplyOsmRef: (osm_ref: string) => Promise<boolean>;
    /** Parent loading state disables submit. */
    busy: boolean;
}

export function CustomCentroidModal({
    open,
    onClose,
    onApplyLatLon,
    onApplyOsmRef,
    busy,
}: CustomCentroidModalProps) {
    const titleId = useId();
    const hintCoordsId = useId();
    const hintOsmId = useId();
    const [coords, setCoords] = useState('');
    const [osmRef, setOsmRef] = useState('');
    const [localError, setLocalError] = useState<string | null>(null);

    useEffect(() => {
        if (open) {
            setLocalError(null);
            setCoords('');
            setOsmRef('');
        }
    }, [open]);

    if (!open) return null;

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setLocalError(null);
        const refTrim = osmRef.trim();
        const coordTrim = coords.trim();
        if (refTrim) {
            const parsed = parseOsmRef(refTrim);
            if ('error' in parsed) {
                setLocalError(parsed.error);
                return;
            }
            const ok = await onApplyOsmRef(refTrim);
            if (ok) onClose();
            return;
        }
        if (coordTrim) {
            const parsed = parseLatLonPairInput(coordTrim);
            if ('error' in parsed) {
                setLocalError(parsed.error);
                return;
            }
            const ok = await onApplyLatLon(parsed.lat, parsed.lon);
            if (ok) onClose();
            return;
        }
        setLocalError('Enter latitude and longitude, or an OSM reference (not both required).');
    };

    return (
        <div
            className="custom-centroid-modal__backdrop"
            role="presentation"
            onMouseDown={(ev) => {
                if (ev.target === ev.currentTarget) onClose();
            }}
        >
            <div
                className="custom-centroid-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
            >
                <h2 id={titleId} className="custom-centroid-modal__title">
                    Custom location
                </h2>
                <p className="custom-centroid-modal__hint">
                    If you fill <strong>OSM reference</strong> below, it takes priority. Otherwise use{' '}
                    <strong>latitude, longitude</strong> (comma or slash). The sampling cell is centred on that
                    point; grid stats use the nearest cell. Keeping the cell automatically sets the focus POI to
                    that centre (no random POI draw).
                </p>
                <form onSubmit={(e) => void handleSubmit(e)}>
                    <div className="custom-centroid-modal__fields">
                        <label className="custom-centroid-modal__label">
                            Latitude, longitude (°)
                            <input
                                type="text"
                                name="coords"
                                inputMode="decimal"
                                autoComplete="off"
                                aria-describedby={hintCoordsId}
                                placeholder="e.g. 45.5017, -73.5673"
                                value={coords}
                                onChange={(ev) => setCoords(ev.target.value)}
                                disabled={busy}
                            />
                        </label>
                        <p id={hintCoordsId} className="custom-centroid-modal__microhint">
                            Decimal degrees; lat then lon.
                        </p>
                        <label className="custom-centroid-modal__label">
                            OSM node, way, or relation
                            <input
                                type="text"
                                name="osmRef"
                                autoComplete="off"
                                aria-describedby={hintOsmId}
                                placeholder="e.g. way/123456789"
                                value={osmRef}
                                onChange={(ev) => setOsmRef(ev.target.value)}
                                disabled={busy}
                            />
                        </label>
                        <p id={hintOsmId} className="custom-centroid-modal__microhint">
                            Node → that point; way or relation polygon/multipolygon → Overpass centre. Format{' '}
                            <code>node/…</code>, <code>way/…</code>, or <code>relation/…</code>.
                        </p>
                    </div>
                    {localError && <p className="custom-centroid-modal__error">{localError}</p>}
                    <div className="custom-centroid-modal__actions">
                        <button type="button" onClick={onClose} disabled={busy}>
                            Cancel
                        </button>
                        <button type="submit" disabled={busy}>
                            Apply
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
