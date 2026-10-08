// Chart colours. The three series colours were checked with the data-viz validator (lightness band, chroma floor,
// colour-blind separation across all pairs, contrast): cyan, orange, violet, always in this order. More than three
// series is never solved with more hues: fold the tail into "Other" or draw separate charts.
export const SERIES = ['#0891B2', '#eb6834', '#4a3aa7'] as const;
export const GRID = '#E2E8F0';
export const AXIS = '#64748B';
export const SURFACE = '#FFFFFF';
