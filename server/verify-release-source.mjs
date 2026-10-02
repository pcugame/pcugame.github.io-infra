#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { assertControlWorkflowIdentity } from './verify-github-release-boundaries.mjs';

assertControlWorkflowIdentity({ repository: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF, defaultBranch: process.env.GITHUB_DEFAULT_BRANCH });
const sha = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Exact GITHUB_SHA is required');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== sha) throw new Error('Checked out HEAD differs from GITHUB_SHA');
console.log(`Verified production source ${sha}`);
