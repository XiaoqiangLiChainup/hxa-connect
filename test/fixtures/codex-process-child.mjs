import fs from 'node:fs';

const [readyFile, behavior = 'ignore-term'] = process.argv.slice(2);
if (behavior === 'ignore-term') process.on('SIGTERM', () => {});
fs.writeFileSync(readyFile, JSON.stringify({ pid: process.pid }));
setInterval(() => {}, 1_000);
