import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type { AppConfig } from './api';
import { useAppConfig } from './useAppConfig';

const SAMPLE_CONFIG: AppConfig = {
    osm_editor_url: 'https://www.openstreetmap.org/edit#map={zoom}/{lat}/{lon}',
    poi_focus_radius_m: 150,
};

describe('useAppConfig', () => {
    it('starts in the loading state before the first fetch resolves', () => {
        const fetchConfig = vi.fn().mockImplementation(() => new Promise(() => {}));
        const { result } = renderHook(() => useAppConfig({ fetchConfig }));
        expect(result.current.status).toBe('loading');
        expect(result.current.config).toBeNull();
        expect(result.current.error).toBeNull();
    });

    it('auto-loads the config on mount and transitions to idle', async () => {
        const fetchConfig = vi.fn().mockResolvedValue(SAMPLE_CONFIG);
        const { result } = renderHook(() => useAppConfig({ fetchConfig }));

        await waitFor(() => expect(result.current.status).toBe('idle'));
        expect(result.current.config).toEqual(SAMPLE_CONFIG);
        expect(fetchConfig).toHaveBeenCalledOnce();
    });

    it('surfaces backend errors via status/error fields', async () => {
        const fetchConfig = vi.fn().mockRejectedValue(new Error('boom'));
        const { result } = renderHook(() => useAppConfig({ fetchConfig }));
        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(result.current.error).toBe('boom');
        expect(result.current.config).toBeNull();
    });

    it('reload() re-fetches and replaces the config', async () => {
        const second: AppConfig = { ...SAMPLE_CONFIG, poi_focus_radius_m: 300 };
        const fetchConfig = vi
            .fn()
            .mockResolvedValueOnce(SAMPLE_CONFIG)
            .mockResolvedValueOnce(second);

        const { result } = renderHook(() => useAppConfig({ fetchConfig }));
        await waitFor(() => expect(result.current.config).toEqual(SAMPLE_CONFIG));

        await act(() => result.current.reload());
        expect(result.current.config).toEqual(second);
        expect(fetchConfig).toHaveBeenCalledTimes(2);
    });
});
