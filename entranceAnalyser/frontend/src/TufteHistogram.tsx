/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

/**
 * Minimal Tufte-style histogram of counts: contiguous bars, no axis
 * lines or frame, count printed above each non-empty bar (same visual
 * language as `TufteBarChart`, which handles percentages instead).
 */

export interface TufteHistogramBin {
    /** Label under the bar (e.g. "25–50" or "250+"). */
    label: string;
    /** Number of observations in the bin. */
    count: number;
}

export interface TufteHistogramProps {
    title: string;
    /** Note under the title (e.g. sample size). */
    subtitle?: string;
    bins: TufteHistogramBin[];
}

const CHART_HEIGHT = 180;
// Wide enough for the longest bin label ("750–1000") to stay clear of its
// neighbours — labels are centred under bars this wide, not just the digits.
const BAR_WIDTH = 60;
const BAR_GAP = 2; // histogram bins are contiguous, keep only a hairline
const TOP_PAD = 22; // room for the count printed above each bar
const BOTTOM_PAD = 20; // room for the bin label

/**
 * Render one Tufte-style count histogram as inline SVG.
 * @param props.title Chart title.
 * @param props.subtitle Optional note rendered under the title.
 * @param props.bins One entry per bin (label + count), already in axis order.
 */
export function TufteHistogram({ title, subtitle, bins }: TufteHistogramProps) {
    const width = bins.length * BAR_WIDTH + (bins.length - 1) * BAR_GAP;
    const plotHeight = CHART_HEIGHT - TOP_PAD - BOTTOM_PAD;
    const maxCount = Math.max(1, ...bins.map((b) => b.count));
    const yFor = (count: number) => TOP_PAD + plotHeight * (1 - count / maxCount);

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
                {bins.map((bin, i) => {
                    const x = i * (BAR_WIDTH + BAR_GAP);
                    const y = yFor(bin.count);
                    return (
                        <g key={bin.label}>
                            {bin.count > 0 && (
                                <>
                                    <rect
                                        x={x}
                                        y={y}
                                        width={BAR_WIDTH}
                                        height={yFor(0) - y}
                                        className="tufte-chart__bar"
                                    />
                                    <text
                                        x={x + BAR_WIDTH / 2}
                                        y={y - 6}
                                        textAnchor="middle"
                                        className="tufte-chart__value"
                                    >
                                        {bin.count}
                                    </text>
                                </>
                            )}
                            <text
                                x={x + BAR_WIDTH / 2}
                                y={CHART_HEIGHT - 4}
                                textAnchor="middle"
                                className="tufte-chart__label"
                            >
                                {bin.label}
                            </text>
                        </g>
                    );
                })}
            </svg>
        </figure>
    );
}
