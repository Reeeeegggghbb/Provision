import { blankPattern, emptySection } from './defaults';
import type { PatternDoc, Section, StepValue, TrackId } from './types';

/**
 * Parse a compact step string: `x` = on, `X` = accent, anything else = off.
 * Whitespace and `|` are ignored so rows can be grouped by beat.
 */
export function parseSteps(row: string): StepValue[] {
  return [...row.replace(/[\s|]/g, '')].map((c) => (c === 'X' ? 2 : c === 'x' ? 1 : 0));
}

function section(rows: Partial<Record<TrackId, string>>): Section {
  const lengths = Object.values(rows).map((r) => parseSteps(r!).length);
  const length = Math.max(16, ...lengths);
  const s = emptySection(length);
  for (const [track, row] of Object.entries(rows) as [TrackId, string][]) {
    const parsed = parseSteps(row);
    s.steps[track] = s.steps[track].map((_, i) => parsed[i] ?? 0);
  }
  return s;
}

function houseGroove(): PatternDoc {
  const doc = blankPattern('House Groove');
  doc.bpm = 124;
  doc.swing = 0.54;
  doc.sections = [
    section({
      kick: 'X...|x...|X...|x...',
      closedHat: '..x.|..x.|..x.|..x.',
      clap: '....|X...|....|X...',
    }),
    section({
      kick: 'X...|x...|X...|x...',
      closedHat: 'x.x.|x.x.|x.x.|x.xx',
      openHat: '..x.|..x.|..x.|..x.',
      clap: '....|X...|....|X...',
      rim: '...x|....|.x..|..x.',
    }),
    section({
      kick: 'X...|x...|X...|x...|X...|x...|X...|x.x.',
      closedHat: 'x.x.|x.x.|x.x.|x.x.|x.x.|x.x.|x.x.|xxxx',
      openHat: '..x.|..x.|..x.|..x.|..x.|..x.|..x.|....',
      clap: '....|X...|....|X...|....|X...|....|X.x.',
      tom: '....|....|....|....|....|....|....|..xX',
    }),
    section({
      kick: 'X...|....|....|....',
      closedHat: 'x.x.|x.x.|x.x.|x.x.',
      clap: '....|X...|....|X..x',
    }),
  ];
  return doc;
}

function boomBap(): PatternDoc {
  const doc = blankPattern('Boom Bap');
  doc.bpm = 90;
  doc.swing = 0.6;
  doc.tracks.kick.sampleId = 'builtin:kick-punch';
  doc.sections = [
    section({
      kick: 'X..x|....|..X.|....',
      snare: '....|X...|....|X...',
      closedHat: 'x.x.|x.x.|x.x.|x.x.',
    }),
    section({
      kick: 'X..x|....|..X.|..x.',
      snare: '....|X...|....|X..x',
      closedHat: 'x.x.|x.xx|x.x.|x.x.',
      rim: '..x.|....|...x|....',
    }),
    section({
      kick: 'X..x|....|..X.|....|X..x|....|..X.|.x..',
      snare: '....|X...|....|X...|....|X...|....|X.x.',
      closedHat: 'x.x.|x.x.|x.x.|x.x.|x.x.|x.x.|x.x.|....',
      openHat: '....|....|....|....|....|....|....|x...',
    }),
    section({
      kick: 'X...|....|....|....',
      snare: '....|....|....|X...',
      closedHat: 'x.x.|x.x.|x.x.|x.x.',
    }),
  ];
  return doc;
}

function breakbeat(): PatternDoc {
  const doc = blankPattern('Breakbeat');
  doc.bpm = 132;
  doc.swing = 0.5;
  doc.tracks.kick.sampleId = 'builtin:kick-punch';
  doc.tracks.snare.sampleId = 'builtin:snare-tight';
  doc.sections = [
    section({
      kick: 'X.x.|....|..x.|....',
      snare: '....|X...|....|X...',
      closedHat: 'x.x.|x.x.|x.x.|x.x.',
    }),
    section({
      kick: 'X.x.|....|..x.|.x..',
      snare: '....|X..x|.x..|X...',
      closedHat: 'xxxx|x.xx|xxxx|x.xx',
      openHat: '....|....|....|..x.',
    }),
    section({
      kick: 'X.x.|....|..x.|....',
      snare: '....|X...|....|X.xx',
      closedHat: 'x.x.|x.x.|x.x.|x...',
      tom: '....|....|....|..xx',
    }),
    section({
      kick: 'X...|....|X...|....',
      clap: '....|X...|....|X...',
      rim: 'x..x|..x.|x..x|..x.',
    }),
  ];
  return doc;
}

function electroFunk(): PatternDoc {
  const doc = blankPattern('Electro Funk');
  doc.bpm = 110;
  doc.swing = 0.56;
  doc.tracks.tom.sampleId = 'builtin:tom-mid';
  doc.sections = [
    section({
      kick: 'X...|..x.|..X.|....',
      clap: '....|X...|....|X...',
      closedHat: 'xxxx|xxxx|xxxx|xxxx',
      rim: '..x.|....|x...|..x.',
    }),
    section({
      kick: 'X...|..x.|..X.|..x.',
      clap: '....|X...|....|X...',
      closedHat: 'xxx.|xxx.|xxx.|xxx.',
      openHat: '...x|...x|...x|...x',
      tom: '....|....|....|.x.x',
    }),
    section({
      kick: 'X..x|..x.|..X.|....',
      snare: '....|X...|....|X...',
      clap: '....|X...|....|X...',
      closedHat: 'x.x.|x.x.|x.x.|x.x.',
    }),
    emptySection(16),
  ];
  return doc;
}

export function examplePatterns(): PatternDoc[] {
  return [houseGroove(), boomBap(), breakbeat(), electroFunk()];
}
