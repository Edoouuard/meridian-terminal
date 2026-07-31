/**
 * Hand authored abstract illustration for the hero background, encoded as a data URI so the
 * rupture effect can use it as a CSS background-image and slice it into shards. Coordinates are
 * fixed (no randomness) so the server and client render byte-identical output.
 */
const RIBBONS = [
  "M -100,650 C 250,600 400,750 700,600 C 1000,450 1150,520 1500,380",
  "M -100,780 C 300,820 500,680 800,720 C 1100,760 1250,650 1550,600",
  "M -100,520 C 220,460 380,560 650,460 C 950,350 1100,420 1500,260",
  "M 200,900 C 450,760 600,830 850,700 C 1100,570 1250,610 1450,480",
];

const NODES: Array<[number, number, number]> = [
  [1180, 210, 5],
  [1290, 300, 3.5],
  [1080, 340, 3],
  [1380, 180, 3.5],
  [1230, 420, 2.5],
  [1420, 320, 4],
  [960, 260, 2.5],
  [1340, 440, 3],
  [1500, 240, 2.5],
  [1100, 150, 3],
];

const LINKS: Array<[number, number, number, number]> = [
  [1180, 210, 1290, 300],
  [1290, 300, 1420, 320],
  [1080, 340, 1180, 210],
  [1380, 180, 1290, 300],
  [1230, 420, 1340, 440],
  [960, 260, 1080, 340],
  [1500, 240, 1420, 320],
  [1100, 150, 1380, 180],
];

function svgMarkup(): string {
  const ribbonPaths = RIBBONS.map(
    (d, i) =>
      `<path d="${d}" fill="none" stroke="url(#ribbon)" stroke-width="${2.4 - i * 0.3}" opacity="${0.5 - i * 0.08}" stroke-linecap="round" />`,
  ).join("");

  const linkLines = LINKS.map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#b68235" stroke-width="1" opacity="0.18" />`).join("");

  const nodeDots = NODES.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#b68235" opacity="0.55" />`).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">
    <defs>
      <linearGradient id="ribbon" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#e1ad66" />
        <stop offset="1" stop-color="#7d5411" />
      </linearGradient>
    </defs>
    ${ribbonPaths}
    ${linkLines}
    ${nodeDots}
  </svg>`;
}

export const HERO_BACKGROUND_IMAGE = `url("data:image/svg+xml,${encodeURIComponent(svgMarkup())}")`;
