const DEFAULT_SPECIES = 'duck';

function normalizeSpriteFrame(species, frame) {
  const frames = BODIES[species] || BODIES[DEFAULT_SPECIES];
  const safeFrame = Number.isFinite(frame) ? frame : 0;
  const frameIndex = Math.abs(Math.trunc(safeFrame)) % frames.length;
  return frames[frameIndex];
}

function renderSprite(species, eye, hat, frame = 0) {
  const frames = BODIES[species] || BODIES[DEFAULT_SPECIES];
  const frameLines = normalizeSpriteFrame(species, frame);
  const lines = frameLines.map((line) => line.replaceAll('{E}', eye));
  const hatLine = HAT_LINES[hat];

  // Match buddy runtime: only draw hat into line 0 when line 0 is empty.
  if (hat !== 'none' && hatLine && lines[0] && !lines[0].trim()) {
    lines[0] = hatLine;
  }

  // Match buddy runtime: drop blank hat slot only when all frames have blank line 0.
  if (lines[0] && !lines[0].trim() && frames.every((f) => f[0] && !f[0].trim())) {
    lines.shift();
  }

  return lines.join('\n');
}
