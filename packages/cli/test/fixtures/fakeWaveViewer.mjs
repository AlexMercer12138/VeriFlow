import { writeFileSync } from 'node:fs';

const [, , capturePath, ...args] = process.argv;
writeFileSync(capturePath, JSON.stringify({ cwd: process.cwd(), args }), 'utf8');
