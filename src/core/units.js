// Fixed-point helpers. All on-chain amounts are BigInt in base units.
//   FDK      18 decimals (utility token)
//   STABLE    6 decimals (settlement stablecoin)
//   Credits   integer kilograms of CO2e (1 tonne = 1000 kg)
export const DECIMALS = { FDK: 18, STABLE: 6 };

export function parseUnits(value, decimals) {
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount "${value}"`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`too many decimals in "${value}"`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export function formatUnits(value, decimals, maxFrac = 4) {
  const v = BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + w + (frac ? '.' + frac : '');
}

export const fdk = (v) => parseUnits(v, DECIMALS.FDK);
export const stable = (v) => parseUnits(v, DECIMALS.STABLE);
export const tonnesToKg = (t) => parseUnits(t, 3);
export const formatFdk = (v, f) => formatUnits(v, DECIMALS.FDK, f);
export const formatStable = (v, f = 2) => formatUnits(v, DECIMALS.STABLE, f);
export const formatTonnes = (kg, f = 3) => formatUnits(kg, 3, f);
