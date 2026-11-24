import fs from 'node:fs';

const html = fs.readFileSync('c:/Users/Rouya/OneDrive/royal dam erb/royal-dam-desktop/renderer/index.html', 'utf8');
const lines = html.split('\n');

console.log('--- FINDING API CALLS AND SAVE METHODS ---');
lines.forEach((line, idx) => {
  if (/function\s+(save|delete|add|update|load|sync|api)/i.test(line) || /fetch\(/i.test(line)) {
    console.log(`[Line ${idx + 1}] ${line.trim().slice(0, 120)}`);
  }
});
