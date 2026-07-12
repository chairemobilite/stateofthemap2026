/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Dropdown + alpha slider for picking the sampling strategy.
//!
//! Kept as its own component so `SamplingPanel` stays a thin layout and
//! the selector can be unit-tested in isolation. Triggering a change
//! (either the <select> or the slider) fires `onChange` with the fully
//! resolved `Strategy` — callers don't need to stitch name+alpha back
//! together themselves.

import type { Strategy, StrategyName } from './api';

export interface StrategySelectorProps {
    strategy: Strategy;
    onChange: (next: Strategy) => void;
    disabled?: boolean;
}

/** Ordered for the dropdown: blended first because it's the default. */
const STRATEGY_OPTIONS: ReadonlyArray<{ value: StrategyName; label: string; hint: string }> = [
    { value: 'blended', label: 'Blended (pop + built)', hint: '50/50 mix of population and built volume' },
    { value: 'population', label: 'Population', hint: 'weighted by residents only' },
    { value: 'built', label: 'Built volume', hint: 'weighted by built m³ only (rescues industrial areas)' },
    { value: 'uniform', label: 'Uniform', hint: 'every inhabited cell equally likely' },
];

const ALPHA_FMT = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

export function StrategySelector({ strategy, onChange, disabled }: StrategySelectorProps) {
    const selected = STRATEGY_OPTIONS.find((o) => o.value === strategy.name) ?? STRATEGY_OPTIONS[0];
    return (
        <fieldset className="strategy-selector" disabled={disabled}>
            <legend>Sampling strategy</legend>
            <label className="strategy-selector__name">
                <span className="visually-hidden">Strategy</span>
                <select
                    value={strategy.name}
                    onChange={(e) =>
                        onChange({ ...strategy, name: e.target.value as StrategyName })
                    }
                >
                    {STRATEGY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                            {opt.label}
                        </option>
                    ))}
                </select>
            </label>
            <p className="strategy-selector__hint">{selected.hint}</p>

            {strategy.name === 'blended' && (
                <label className="strategy-selector__alpha">
                    <span>
                        α = {ALPHA_FMT.format(strategy.alpha)} &nbsp;
                        <small>
                            ({Math.round(strategy.alpha * 100)}% built /{' '}
                            {Math.round((1 - strategy.alpha) * 100)}% pop)
                        </small>
                    </span>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={strategy.alpha}
                        aria-label="Blend weight alpha"
                        onChange={(e) =>
                            onChange({ ...strategy, alpha: Number(e.target.value) })
                        }
                    />
                </label>
            )}
        </fieldset>
    );
}
