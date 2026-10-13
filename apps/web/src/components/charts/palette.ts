// Chart colours. The three series colours were checked with the data-viz validator (lightness band, chroma floor,
// colour-blind separation across all pairs, contrast): cyan, orange, violet, always in this order. More than three
// series is never solved with more hues: fold the tail into "Other" or draw separate charts.
export const SERIES = ['#0891B2', '#eb6834', '#4a3aa7'] as const;
// Grid, axis and surface follow the light/dark mode (CSS variables from globals.css).
export const GRID = 'var(--line)';
export const AXIS = 'var(--muted)';
export const SURFACE = 'var(--surface)';
