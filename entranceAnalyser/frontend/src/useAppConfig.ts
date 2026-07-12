/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! `useAppConfig` — fetches the public runtime config from
//! `GET /api/config` once on mount.
//!
//! The backend re-reads its env at startup, so the config is stable
//! for the lifetime of a frontend session: a single load with a
//! permanent in-memory copy is enough. The shape mirrors
//! `useKeptBboxes` (`loading | idle | error` status, injectable
//! fetcher for tests) so call sites have a familiar contract.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchAppConfig, type AppConfig } from './api';

export type AppConfigStatus = 'loading' | 'idle' | 'error';

export interface UseAppConfigOptions {
    /** Override the API module, mostly for tests. */
    fetchConfig?: () => Promise<AppConfig>;
}

export interface AppConfigState {
    config: AppConfig | null;
    status: AppConfigStatus;
    error: string | null;
    reload: () => Promise<void>;
}

/**
 * Load `/api/config` on mount. Until the response lands `config` is
 * `null` and `status === 'loading'`; consumers should gate on `idle`
 * before reading config fields.
 *
 * @param options - Optional overrides; `fetchConfig` lets tests
 *                  substitute the API call without touching `fetch`.
 */
export function useAppConfig(options: UseAppConfigOptions = {}): AppConfigState {
    const fetchConfig = useMemo(
        () => options.fetchConfig ?? (() => fetchAppConfig()),
        [options.fetchConfig],
    );

    const [config, setConfig] = useState<AppConfig | null>(null);
    const [status, setStatus] = useState<AppConfigStatus>('loading');
    const [error, setError] = useState<string | null>(null);
    // StrictMode double-invokes effects in dev; this ref stops the
    // initial fetch from firing twice, matching `useKeptBboxes`.
    const bootstrapped = useRef(false);

    const reload = useCallback(async () => {
        setStatus('loading');
        setError(null);
        try {
            setConfig(await fetchConfig());
            setStatus('idle');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStatus('error');
        }
    }, [fetchConfig]);

    useEffect(() => {
        if (bootstrapped.current) return;
        bootstrapped.current = true;
        void reload();
    }, [reload]);

    return { config, status, error, reload };
}
