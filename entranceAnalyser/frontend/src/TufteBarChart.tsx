/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

/**
 * Minimal Tufte-style bar chart: no axis lines or frame; the scale is
 * suggested by thin white gridlines drawn *over* the bars only (they
 * vanish outside the ink, as in Tufte's redesign of the bar chart).
 * Values are percentages (0–100).
 */

export interface TufteBar {
    /** Category label under the bar. */
    label: string;
    /** Bar value in percent (0–100). */
    value: number;
}

export interface TufteBarChartProps {
    title: string;
    /** Note under the title (e.g. sample size). */
    subtitle?: string;
    bars: TufteBar[];
}

const CHART_HEIGHT = 160;
const BAR_WIDTH = 72;
const BAR_GAP = 36;
const TOP_PAD = 22; // room for the value printed above each bar
const BOTTOM_PAD = 20; // room for the category label
/** Percent positions of the white scale lines overprinted on the bars. */
const GRID_PERCENTS = [25, 50, 75];

/**
 * Render one Tufte-style percentage bar chart as inline SVG.
 * @param props.title Chart title.
 * @param props.subtitle Optional note rendered under the title.
 * @param props.bars One entry per bar (label + percent value).
 */
export function TufteBarChart({ title, subtitle, bars }: TufteBarChartProps) {
    const width = bars.length * BAR_WIDTH + (bars.length - 1) * BAR_GAP;
    const plotHeight = CHART_HEIGHT - TOP_PAD - BOTTOM_PAD;
    const yFor = (pct: number) => TOP_PAD + plotHeight * (1 - pct / 100);

    return (
        <figure className="tufte-chart">
            <figcaption>
                <span className="tufte-chart__title">{title}</span>
                {subtitle && <span className="tufte-chart__subtitle">{subtitle}</span>}
            </figcaption>
            <svg
                width={width}
                height={CHART_HEIGHT}
                viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
                role="img"
                aria-label={title}
            >
                {bars.map((bar, i) => {
                    const x = i * (BAR_WIDTH + BAR_GAP);
                    const y = yFor(bar.value);
                    return (
                        <g key={bar.label}>
                            <rect
                                x={x}
                                y={y}
                                width={BAR_WIDTH}
                                height={yFor(0) - y}
                                className="tufte-chart__bar"
                            />
                            {/* Scale lines only where they cross the ink. */}
                            {GRID_PERCENTS.filter((p) => p < bar.value).map((p) => (
                                <line
                                    key={p}
                                    x1={x}
                                    x2={x + BAR_WIDTH}
                                    y1={yFor(p)}
                                    y2={yFor(p)}
                                    className="tufte-chart__gridline"
                                />
                            ))}
                            <text
                                x={x + BAR_WIDTH / 2}
                                y={y - 6}
                                textAnchor="middle"
                                className="tufte-chart__value"
                            >
                                {`${Math.round(bar.value)}%`}
                            </text>
                            <text
                                x={x + BAR_WIDTH / 2}
                                y={CHART_HEIGHT - 4}
                                textAnchor="middle"
                                className="tufte-chart__label"
                            >
                                {bar.label}
                            </text>
                        </g>
                    );
                })}
            </svg>
        </figure>
    );
}
