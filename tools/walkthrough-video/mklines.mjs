// Writes <out>/audio/lines.tsv: id <TAB> text as it should be spoken.
import fs from 'node:fs';
import path from 'node:path';
import { LINES } from './lines.mjs';
import { OUT } from './kit.mjs';
const SAY = [
  [/\bHOD's\b/g, "H O D's"], [/\bHOD\b/g, 'H O D'], [/\bPMS\b/g, 'P M S'], [/\bOEM\b/g, 'O E M'], [/\bAMC\b/g, 'A M C'], [/\bCMC\b/g, 'C M C'],
  [/\bICU\b/g, 'I C U'], [/\bDG\b/g, 'D G'], [/\bNOC\b/g, 'N O C'], [/\bPDF\b/g, 'P D F'], [/\bID\b/g, 'I D'], [/\bQR\b/g, 'Q R'],
  [/\bZIP\b/g, 'zip'], [/\bPESO\b/g, 'pesso'], [/\bA4\b/g, 'A 4'], [/\bBME\b/g, 'B M E'],
];
const spoken = (t) => SAY.reduce((s, [re, r]) => s.replace(re, r), t);
fs.mkdirSync(path.join(OUT, 'audio'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'audio', 'lines.tsv'), Object.entries(LINES).map(([id, [, t]]) => `${id}\t${spoken(t)}`).join('\n') + '\n');
console.log(Object.keys(LINES).length, 'lines');
