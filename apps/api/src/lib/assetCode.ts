import { ASSET_PATTERN_TOKEN } from '@bme/shared';

type Parts = { hosp: string; dept: string; type: string; loc: string; seq: number };

// '{HOSP}-{DEPT}-{TYPE}-{LOC}-{SEQ:3}' + parts → 'SHL-BME-VENT-ICU1-001'
export function formatAssetCode(pattern: string, p: Parts): string {
  return pattern.replace(ASSET_PATTERN_TOKEN, (token) => {
    if (token === '{HOSP}') return p.hosp;
    if (token === '{DEPT}') return p.dept;
    if (token === '{TYPE}') return p.type;
    if (token === '{LOC}') return p.loc;
    return String(p.seq).padStart(Number(token.slice(5, -1)), '0'); // {SEQ:n}
  });
}
