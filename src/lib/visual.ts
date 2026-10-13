const PALETTES: Array<[string, string]> = [
  ["#3a2a12", "#8a5a12"],
  ["#1c2438", "#3d4d7a"],
  ["#2a1218", "#7a2438"],
  ["#12261e", "#1f6a4a"],
  ["#241a33", "#5b3d86"],
  ["#2b2414", "#c49212"],
];

export function paletteFor(seed: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTES[hash % PALETTES.length];
}
