#!/usr/bin/env node
/**
 * convert-legacy.mjs
 *
 * Reads all legacy_example_20XX_projects.json files and produces
 * a single combined import JSON compatible with `seed.ts --import`.
 *
 * Usage:
 *   node server/convert-legacy.mjs > server/legacy-import.json
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const YEAR_FILES = readdirSync(__dirname)
  .filter(f => /^legacy_example_(\d{4})_projects\.json$/.test(f))
  .sort();

const years = [];
const projects = [];

for (const file of YEAR_FILES) {
  const yearMatch = file.match(/(\d{4})/);
  if (!yearMatch) continue;
  const year = parseInt(yearMatch[1], 10);

  years.push({
    year,
    title: `${year} 졸업작품전`,
    isUploadEnabled: false,
  });

  const raw = JSON.parse(readFileSync(join(__dirname, file), 'utf-8'));

  for (const entry of raw) {
    const members = [];
    const nameCount = entry.names?.length ?? 0;

    for (let i = 0; i < nameCount; i++) {
      members.push({
        name: entry.names[i],
        studentId: entry.studentIds?.[i] ?? '',
        sortOrder: i,
      });
    }

    // Determine platforms
    const platforms = [];
    if (entry.isMobile === true) {
      platforms.push('MOBILE');
    } else if (entry.isMobile === false) {
      platforms.push('PC');
    } else {
      // 2020-2022, 2024: no isMobile field — default to PC
      platforms.push('PC');
    }

    const project = {
      year,
      title: entry.title,
      status: 'PUBLISHED',
      downloadPolicy: 'PUBLIC',
      platforms,
      members,
    };

    // 2025 data has githubLink
    if (entry.githubLink) {
      project.githubUrl = entry.githubLink;
    }

    projects.push(project);
  }
}

const output = { years, projects };

console.log(JSON.stringify(output, null, 2));
