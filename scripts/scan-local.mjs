#!/usr/bin/env node
/**
 * Run the verified-community-node scanner against this working tree, before publishing.
 *
 * `npx @n8n/scan-community-package <name>` only accepts a published npm package: it
 * resolves the version from the registry, checks provenance, then lints two things —
 * the GitHub source the attestation points at, and the downloaded tarball. That is a
 * chicken-and-egg problem pre-release, so this reproduces both lint legs locally by
 * calling the scanner's exported `analyzePackage(dir, patterns)` directly.
 *
 * What it does NOT cover (only the real CLI can, post-publish): the provenance check.
 * Publish with `--provenance` from GitHub Actions on a public repo or that leg fails.
 *
 *   node scripts/scan-local.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCANNER = '@n8n/scan-community-package';
const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

// Install the scanner into a throwaway prefix so its own deps (eslint, the two n8n
// plugins) resolve, without adding it to this package's devDependencies.
const work = mkdtempSync(join(tmpdir(), 'td-n8n-scan-'));
console.log(`Installing ${SCANNER}...`);
execFileSync('npm', ['install', '--silent', '--prefix', work, SCANNER], { stdio: 'inherit' });

const scannerDir = join(work, 'node_modules', SCANNER, 'dist');
const { analyzePackage, SOURCE_FILE_PATTERNS } = await import(join(scannerDir, 'scanner.js'));

// Reproduce the tarball leg on a real `npm pack` output rather than on `dist/`: the
// published artifact is what gets scanned, and `files`/`main` decide what lands in it.
console.log('Packing...');
execFileSync('npm', ['pack', '--pack-destination', work], { cwd: repoRoot, stdio: 'inherit' });
const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
execFileSync('tar', ['-xzf', join(work, tgz), '-C', work]);

// Patterns copied from the scanner's own `analyzePackageByName`: the source leg gets the
// full ruleset on real `.ts`, the tarball leg only compiled `.js` plus the published
// package.json (`.d.ts` files false-positive on the filename-convention rules there).
const legs = [
	['SOURCE  (provenance checkout)', repoRoot, SOURCE_FILE_PATTERNS],
	['TARBALL (published artifact)', join(work, 'package'), ['**/*.js', 'package.json']],
];

let failed = false;
for (const [label, dir, patterns] of legs) {
	const result = await analyzePackage(dir, patterns);
	console.log(`\n===== ${label} =====`);
	if (result.passed) {
		console.log('PASSED');
	} else {
		failed = true;
		console.log(`FAILED: ${result.message}`);
		if (result.details) console.log(result.details);
	}
}

console.log(
	failed
		? '\nScan failed — fix the errors above before publishing. (Warnings do not fail the scan.)'
		: '\nScan passed. Remaining gate: npm provenance from a public GitHub repo.',
);
process.exit(failed ? 1 : 0);
