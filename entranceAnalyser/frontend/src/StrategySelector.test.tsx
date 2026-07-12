/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { Strategy, StrategyName } from './api';
import { StrategySelector } from './StrategySelector';

const BASE: Strategy = { name: 'blended', alpha: 0.5 };

describe('<StrategySelector />', () => {
    it.each<[StrategyName, string]>([
        ['uniform', 'Uniform'],
        ['population', 'Population'],
        ['built', 'Built volume'],
        ['blended', 'Blended (pop + built)'],
    ])('renders the label for %s', (name, label) => {
        render(<StrategySelector strategy={{ ...BASE, name }} onChange={vi.fn()} />);
        expect((screen.getByRole('combobox') as HTMLSelectElement).selectedOptions[0].text).toBe(label);
    });

    it('only shows the alpha slider when strategy is blended', () => {
        const { rerender } = render(
            <StrategySelector strategy={{ ...BASE, name: 'uniform' }} onChange={vi.fn()} />,
        );
        expect(screen.queryByRole('slider')).toBeNull();

        rerender(<StrategySelector strategy={BASE} onChange={vi.fn()} />);
        expect(screen.getByRole('slider')).toBeInTheDocument();
    });

    it('reports the new name on dropdown change', () => {
        const onChange = vi.fn<(s: Strategy) => void>();
        render(<StrategySelector strategy={BASE} onChange={onChange} />);
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'built' } });
        expect(onChange).toHaveBeenCalledExactlyOnceWith({ name: 'built', alpha: 0.5 });
    });

    it('reports the new alpha on slider change', () => {
        const onChange = vi.fn<(s: Strategy) => void>();
        render(<StrategySelector strategy={BASE} onChange={onChange} />);
        fireEvent.change(screen.getByRole('slider'), { target: { value: '0.75' } });
        expect(onChange).toHaveBeenCalledExactlyOnceWith({ name: 'blended', alpha: 0.75 });
    });

    it('disables every control while the parent is busy', () => {
        render(<StrategySelector strategy={BASE} onChange={vi.fn()} disabled />);
        expect(screen.getByRole('combobox')).toBeDisabled();
        expect(screen.getByRole('slider')).toBeDisabled();
    });
});
