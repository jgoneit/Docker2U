#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Inventory the exact installed production graph and locked Cargo graph without
// package-manager state writes. Optional supplemental texts are verified at their URLs.
const root = fileURLToPath(new URL('..', import.meta.url));
const target = 'aarch64-apple-darwin';
const options = {};
const usage = 'node scripts/release-metadata.mjs --app <Docker2U.app> --dmg <file.dmg> --out <artifact-directory> --source <build-commit> --build-receipt <CANDIDATE.json> [--release-source <same-tree-commit>] [--supplemental-licenses <map.json>] [--dry-run]';
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--dry-run') options.dryRun = true;
  else if (['--app', '--dmg', '--out', '--source', '--build-receipt', '--release-source', '--supplemental-licenses'].includes(arg)) {
    const value = process.argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}\n${usage}`);
    options[arg.slice(2)] = value;
  } else throw new Error(`Unknown option ${arg}\n${usage}`);
}
function run(command, args, { optional = false, stderr = false } = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    if (optional) return null;
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return (stderr ? result.stderr : result.stdout).trim();
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fileHash = (path) => sha256(readFileSync(path));
const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8'));
const manifest = readJSON(join(root, 'package.json'));
const config = readJSON(join(root, 'src-tauri/tauri.conf.json'));
const sourceCommit = run('git', ['rev-parse', `${options.source ?? 'HEAD'}^{commit}`]);
const sourceTree = run('git', ['rev-parse', `${sourceCommit}^{tree}`]);
const releaseSourceCommit = options['release-source'] ? run('git', ['rev-parse', `${options['release-source']}^{commit}`]) : sourceCommit;
const releaseSourceTree = run('git', ['rev-parse', `${releaseSourceCommit}^{tree}`]);
if (releaseSourceTree !== sourceTree) throw new Error('--release-source must have the exact same Git tree as the build source.');
const initialStatus = run('git', ['status', '--porcelain', '--untracked-files=normal']);
if (!options.dryRun) {
  for (const option of ['app', 'dmg', 'out', 'source', 'build-receipt']) if (!options[option]) throw new Error(`Missing --${option}\n${usage}`);
  if (initialStatus) throw new Error('Release metadata requires a clean source tree, including untracked files. Commit source changes first.');
  if (run('git', ['rev-parse', 'HEAD']) !== sourceCommit) throw new Error('--source must identify the checked-out HEAD used to build the app.');
  if (resolve(dirname(options.dmg)) !== resolve(options.out)) throw new Error('--dmg must already be in --out alongside RELEASE-NOTES.md.');
  if (!existsSync(join(options.out, 'RELEASE-NOTES.md'))) throw new Error('--out must contain RELEASE-NOTES.md.');
}
if (manifest.version !== config.version) throw new Error('package.json and tauri.conf.json versions differ.');
function validateBuildReceipt(receipt, commit, tree, version) {
  if (receipt.sourceCommit !== commit) throw new Error('Build receipt sourceCommit does not match the checked-out build source.');
  if (receipt.sourceTree !== tree) throw new Error('Build receipt sourceTree does not match the build source tree.');
  if (receipt.version !== version) throw new Error('Build receipt version does not match the application version.');
  if (typeof receipt.runUrl !== 'string' || !/^https:\/\/github\.com\/[^/?#]+\/[^/?#]+\/actions\/runs\/\d+$/.test(receipt.runUrl)) throw new Error('Build receipt requires a GitHub Actions run URL.');
  for (const tool of ['node', 'pnpm', 'rustc', 'cargo', 'macos', 'xcode']) {
    if (typeof receipt.toolchain?.[tool] !== 'string' || !receipt.toolchain[tool].trim()) throw new Error(`Build receipt is missing toolchain.${tool}.`);
  }
  if (typeof receipt.artifacts?.dmg?.name !== 'string' || receipt.artifacts.dmg.name !== basename(receipt.artifacts.dmg.name) || !receipt.artifacts.dmg.name.endsWith('.dmg')) throw new Error('Build receipt requires a DMG filename without a directory.');
  for (const artifact of ['dmg', 'binary']) {
    if (typeof receipt.artifacts?.[artifact]?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.artifacts[artifact].sha256)) throw new Error(`Build receipt requires artifacts.${artifact}.sha256.`);
  }
  if (!receipt.verification || typeof receipt.verification !== 'object' || Array.isArray(receipt.verification)) throw new Error('Build receipt requires a verification object.');
}
let buildReceipt = null;
let buildReceiptInput = null;
if (options['build-receipt']) {
  const path = resolve(options['build-receipt']);
  const bytes = readFileSync(path);
  buildReceipt = JSON.parse(bytes.toString('utf8'));
  validateBuildReceipt(buildReceipt, sourceCommit, sourceTree, manifest.version);
  buildReceiptInput = { file: basename(path), sha256: sha256(bytes) };
}
function verifyBuildArtifactHashes(receipt, dmgName, dmgHash, binaryHash) {
  if (receipt.artifacts.dmg.name !== dmgName) throw new Error('DMG filename differs from the build receipt.');
  if (receipt.artifacts.dmg.sha256 !== dmgHash) throw new Error('DMG SHA-256 differs from the build receipt.');
  if (receipt.artifacts.binary.sha256 !== binaryHash) throw new Error('App executable SHA-256 differs from the build receipt.');
}
const inputs = ['package.json', 'pnpm-lock.yaml', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json']
  .map((path) => ({ path, sha256: fileHash(join(root, path)) }));

// Read only v9 registry integrity records, not arbitrary YAML. Fail closed when a
// traversed installed package has no matching lock entry; do not guess a checksum.
const pnpmLock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
if (!/^lockfileVersion: ['"]?9\.0['"]?\s*$/m.test(pnpmLock)) throw new Error('Expected pnpm lockfile version 9.0.');
const integrities = new Map();
let inPackages = false;
let lockKey;
for (const line of pnpmLock.split('\n')) {
  if (line === 'packages:') { inPackages = true; continue; }
  if (inPackages && /^\S/.test(line)) break;
  if (!inPackages) continue;
  const key = line.match(/^  (.+):$/);
  if (key) lockKey = key[1].replace(/^['"]|['"]$/g, '');
  const integrity = line.match(/^    resolution: \{integrity: (sha(?:256|384|512)-[A-Za-z0-9+/=]+)(?:,|\})/);
  if (integrity && lockKey) integrities.set(lockKey, integrity[1]);
}
const cargoLock = readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8');
const cargoChecksums = new Map();
for (const block of cargoLock.split(/^\[\[package\]\]\s*$/m).slice(1)) {
  const field = (name) => block.match(new RegExp(`^${name} = "([^"\\n]+)"$`, 'm'))?.[1];
  if (field('checksum')) cargoChecksums.set(`${field('name')}@${field('version')}|${field('source')}`, field('checksum'));
}
const publicURL = (value) => {
  if (!value) return null;
  try {
    const url = new URL(String(value).replace(/^git\+/, ''));
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.username = ''; url.password = ''; url.search = '';
    return url.href;
  } catch { return null; }
};
const texts = new Map();
// Deliberately exclude executables/source maps such as copyright.mjs and COPYING.js.
const documentExtensions = new Set(['', '.txt', '.md', '.markdown', '.rst', '.html', '.htm']);
function licenseDocument(name) {
  const upper = name.toUpperCase();
  if (!/^(?:LICEN[CS]E|LICEN[CS]ES|COPYING|COPYRIGHT|NOTICE|NOTICES|UNLICENSE)(?:$|[-_. ])/.test(upper)) return false;
  const ext = extname(name).toLowerCase();
  return documentExtensions.has(ext)
    || /^\.(?:mit|apache|bsd|isc|lgpl|gpl|mpl|lesser|unlicense)(?:-\d[\d.]*)?$/.test(ext)
    || /^(?:LICEN[CS]E|COPYING)[._ -](?:APACHE|GPL|LGPL|MPL)[._ -]?(?:V)?\d+(?:\.\d+)*$/.test(upper);
}
function licenseTexts(directory, explicit = null) {
  const candidates = new Set();
  const visit = (dir, depth = 0) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isFile() && licenseDocument(entry.name)) candidates.add(path);
      else if (entry.isDirectory() && depth < 2 && /^(?:licenses?|licences?|legal|notices?|docs?)$/i.test(entry.name)) visit(path, depth + 1);
    }
  };
  visit(directory);
  if (explicit) {
    const path = resolve(directory, explicit);
    const local = relative(realpathSync(directory), existsSync(path) ? realpathSync(path) : path);
    if (!local.startsWith('..') && !local.startsWith('/') && existsSync(path) && statSync(path).isFile() && licenseDocument(basename(path))) candidates.add(path);
  }
  return [...candidates].sort().map((path) => {
    const content = readFileSync(path);
    if (content.includes(0)) throw new Error(`Non-text license document: ${path}`);
    const hash = sha256(content);
    texts.set(hash, content.toString('utf8'));
    return { file: relative(directory, path), sha256: hash };
  });
}
const packages = new Map();
function register(entry, directory, licenseFile) {
  const licenses = licenseTexts(directory, licenseFile);
  entry.license_texts = licenses;
  entry.packaged_license_text_status = licenses.length ? 'available' : 'missing';
  entry.license_text_status = licenses.length ? 'available' : 'missing';
  packages.set(entry.id, entry);
  return entry;
}
function findPackage(name, from) {
  let directory = from;
  while (true) {
    const candidate = join(directory, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return dirname(realpathSync(candidate));
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
const visitedNpm = new Set();
function npmPackage(directory) {
  const data = readJSON(join(directory, 'package.json'));
  const id = `npm:${data.name}@${data.version}`;
  if (visitedNpm.has(directory)) return id;
  visitedNpm.add(directory);
  const integrity = integrities.get(`${data.name}@${data.version}`);
  if (!integrity) throw new Error(`Installed ${id} has no registry integrity in pnpm-lock.yaml. Run a frozen install before release.`);
  const split = integrity.indexOf('-');
  const entry = packages.get(id) ?? register({
    id, ecosystem: 'npm', name: data.name, version: data.version,
    license: typeof data.license === 'string' ? data.license : (data.license?.type ?? data.licenses?.map((v) => v.type).join(' OR ') ?? null),
    source: `https://www.npmjs.com/package/${data.name}/v/${data.version}`,
    repository: publicURL(typeof data.repository === 'string' ? data.repository : data.repository?.url),
    checksum: { algorithm: integrity.slice(0, split), encoding: 'base64', value: integrity.slice(split + 1), source: 'pnpm-lock.yaml' },
    dependencies: [],
  }, directory);
  const names = new Set([...Object.keys(data.dependencies ?? {}), ...Object.keys(data.optionalDependencies ?? {}), ...Object.keys(data.peerDependencies ?? {})]);
  for (const name of [...names].sort()) {
    const optional = name in (data.optionalDependencies ?? {}) || data.peerDependenciesMeta?.[name]?.optional === true;
    const child = findPackage(name, directory);
    if (!child) { if (optional) continue; throw new Error(`Required dependency ${name} of ${id} is not installed.`); }
    const dependencyId = npmPackage(child);
    const kinds = [];
    if (name in (data.dependencies ?? {})) kinds.push('normal');
    if (name in (data.optionalDependencies ?? {})) kinds.push('optional');
    if (name in (data.peerDependencies ?? {})) kinds.push('peer');
    const existing = entry.dependencies.find((dependency) => dependency.id === dependencyId);
    if (existing) existing.kinds = [...new Set([...existing.kinds, ...kinds])].sort();
    else entry.dependencies.push({ id: dependencyId, kinds });
  }
  entry.dependencies.sort((a, b) => a.id.localeCompare(b.id));
  return id;
}
const npmRoots = [];
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
  const directory = findPackage(name, root);
  if (!directory) {
    if (name in (manifest.optionalDependencies ?? {})) continue;
    throw new Error(`Production dependency ${name} is not installed.`);
  }
  const installed = readJSON(join(directory, 'package.json'));
  const specified = manifest.dependencies?.[name] ?? manifest.optionalDependencies[name];
  if (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(specified) && specified !== installed.version) throw new Error(`Installed ${name}@${installed.version} differs from package.json ${specified}.`);
  npmRoots.push(npmPackage(directory));
}
const cargo = JSON.parse(run('cargo', ['metadata', '--format-version', '1', '--locked', '--offline', '--filter-platform', target, '--manifest-path', 'src-tauri/Cargo.toml']));
const cargoById = new Map(cargo.packages.map((pkg) => [pkg.id, pkg]));
const nodes = new Map(cargo.resolve.nodes.map((node) => [node.id, node]));
const cargoRoot = cargo.resolve.root;
if (!cargoRoot || cargoById.get(cargoRoot)?.version !== manifest.version) throw new Error('Cargo root/version does not match the application.');
const cargoId = (id) => {
  const pkg = cargoById.get(id);
  return `cargo:${pkg.name}@${pkg.version}`;
};
const visitedCargo = new Set();
function cargoPackage(id) {
  if (visitedCargo.has(id)) return;
  visitedCargo.add(id);
  const pkg = cargoById.get(id);
  if (!pkg) throw new Error(`Cargo dependency metadata missing for ${id}.`);
  const dependencies = (nodes.get(id)?.deps ?? []).flatMap((dep) => {
    const kinds = [...new Set(dep.dep_kinds.map((kind) => kind.kind ?? 'normal').filter((kind) => kind !== 'dev'))].sort();
    return kinds.length ? [{ original: dep.pkg, id: cargoId(dep.pkg), kinds }] : [];
  });
  if (id !== cargoRoot) {
    if (packages.has(cargoId(id))) throw new Error(`Ambiguous Cargo name/version from multiple sources: ${cargoId(id)}.`);
    const checksum = cargoChecksums.get(`${pkg.name}@${pkg.version}|${pkg.source}`);
    if (!checksum || !pkg.source?.startsWith('registry+')) throw new Error(`Expected locked registry checksum for ${cargoId(id)}.`);
    const directory = dirname(pkg.manifest_path);
    const checksumFile = join(directory, '.cargo-checksum.json');
    if (existsSync(checksumFile) && readJSON(checksumFile).package !== checksum) throw new Error(`Installed registry checksum differs from Cargo.lock for ${cargoId(id)}.`);
    register({
      id: cargoId(id), ecosystem: 'cargo', name: pkg.name, version: pkg.version, license: pkg.license,
      source: `https://crates.io/crates/${pkg.name}/${pkg.version}`, repository: publicURL(pkg.repository),
      checksum: { algorithm: 'sha256', encoding: 'hex', value: checksum, source: 'src-tauri/Cargo.lock' },
      dependencies: dependencies.map(({ original: _original, ...dep }) => dep).sort((a, b) => a.id.localeCompare(b.id)),
    }, directory, pkg.license_file);
  }
  for (const dep of dependencies) cargoPackage(dep.original);
}
cargoPackage(cargoRoot);
const supplementalInputs = [];
const supplementalFiles = new Map();
if (options['supplemental-licenses']) {
  const mapPath = resolve(options['supplemental-licenses']);
  const mapBytes = readFileSync(mapPath);
  const mappings = JSON.parse(mapBytes.toString('utf8'));
  if (!Array.isArray(mappings)) throw new Error('Supplemental license map must be an array.');
  const mapHash = sha256(mapBytes);
  supplementalFiles.set(mapPath, mapHash);
  const sources = new Map();
  for (const mapping of mappings) {
    if (!Array.isArray(mapping.packages) || !mapping.packages.length || !Array.isArray(mapping.licenses) || !Array.isArray(mapping.sources) || !mapping.sources.length) throw new Error('Each supplemental mapping requires packages, licenses and sources arrays.');
    for (const source of mapping.sources) {
      const url = new URL(source.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(`Expected a public HTTPS source URL: ${source.url}`);
      if (typeof source.filename !== 'string' || source.filename !== basename(source.filename) || (!licenseDocument(source.filename) && !/^(?:MIT|MPL-2\.0|(?:.+[-_])?LICENSE(?:[-_]MIT)?)\.?(?:txt)?$/i.test(source.filename))) throw new Error(`Supplemental source must name a license document: ${source.filename}`);
      const path = resolve(dirname(mapPath), source.file);
      const bytes = readFileSync(path);
      if (bytes.includes(0)) throw new Error(`Non-text supplemental license: ${source.filename}`);
      const hash = sha256(bytes);
      if (source.sha256 && source.sha256 !== hash) throw new Error(`Supplemental input SHA-256 mismatch: ${source.filename}`);
      supplementalFiles.set(path, hash);
      const previous = sources.get(source.url);
      if (previous && previous.sha256 !== hash) throw new Error(`Conflicting local bytes for supplemental source ${source.url}`);
      sources.set(source.url, { source_url: source.url, filename: source.filename, sha256: hash, bytes });
    }
  }
  await Promise.all([...sources.values()].map(async (source) => {
    const response = await fetch(source.source_url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Supplemental source returned HTTP ${response.status}: ${source.source_url}`);
    const remoteBytes = Buffer.from(await response.arrayBuffer());
    if (!remoteBytes.equals(source.bytes)) throw new Error(`Supplemental source bytes differ from the supplied file: ${source.source_url}`);
    texts.set(source.sha256, source.bytes.toString('utf8'));
  }));
  const assignments = [];
  for (const mapping of mappings) {
    for (const name of mapping.packages) {
      const matches = [...packages.values()].filter((pkg) => pkg.id === name || (pkg.ecosystem === 'cargo' && pkg.name === name));
      if (matches.length !== 1) throw new Error(`Supplemental package must match exactly one resolved package: ${name}`);
      const entry = matches[0];
      if (!mapping.licenses.includes(entry.license)) throw new Error(`Supplemental license declaration does not match ${entry.id}: ${entry.license}`);
      for (const source of mapping.sources) {
        const verified = sources.get(source.url);
        if (!entry.license_texts.some((text) => text.source_url === source.url && text.sha256 === verified.sha256)) entry.license_texts.push({ file: source.filename, sha256: verified.sha256, origin: 'upstream-supplement', source_url: source.url });
      }
      entry.license_text_status = entry.packaged_license_text_status === 'missing' ? 'supplemented' : 'available-with-supplement';
      assignments.push({ package_id: entry.id, declared_license: entry.license, sources: mapping.sources.map((source) => ({ source_url: source.url, sha256: sources.get(source.url).sha256 })) });
    }
  }
  supplementalInputs.push({ file: basename(mapPath), sha256: mapHash, verification: 'Each supplied local text matched the exact HTTPS response bytes during metadata generation. Package declarations matched installed metadata; legal applicability remains an audit judgment.', assignments });
}
const inventory = {
  format: 'docker2u-dependency-inventory/v1', application: { name: config.productName, version: manifest.version }, target,
  scope: {
    javascript: 'Installed production dependencies, transitive dependencies and installed peers; optional dependencies absent on this host are omitted.',
    cargo: 'Locked offline Cargo metadata filtered for aarch64-apple-darwin, traversing normal and build dependencies and excluding dev-only edges. This is a resolved build graph, not measured binary composition.',
    license_texts: 'Packaged license/copyright/copying/notice/unlicense documents and optional URL-verified upstream supplements; executable code and maps excluded. Exact bytes deduplicated by SHA-256. Upstream policy documents and canonical license templates remain verbatim; missing copyright attribution is not invented.',
    security: 'This inventory is not a vulnerability scan or a license-compliance determination. Registry checksums identify archives; installed package file contents are not exhaustively verified.',
  },
  inputs, supplemental_license_inputs: supplementalInputs, roots: { npm: npmRoots, cargo: cargoId(cargoRoot) },
  counts: {
    npm: [...packages.values()].filter((pkg) => pkg.ecosystem === 'npm').length,
    cargo: [...packages.values()].filter((pkg) => pkg.ecosystem === 'cargo').length,
    packages: packages.size, unique_license_texts: texts.size,
    packages_without_available_license_text: [...packages.values()].filter((pkg) => pkg.license_text_status === 'missing').length,
    packages_without_packaged_license_text: [...packages.values()].filter((pkg) => pkg.packaged_license_text_status === 'missing').length,
    packages_with_supplemental_license_text: [...packages.values()].filter((pkg) => pkg.license_texts.some((text) => text.origin === 'upstream-supplement')).length,
  },
  packages: [...packages.values()].sort((a, b) => a.id.localeCompare(b.id)),
};
const missing = inventory.packages.filter((pkg) => pkg.license_text_status === 'missing').map((pkg) => pkg.id);
const packagedMissing = inventory.packages.filter((pkg) => pkg.packaged_license_text_status === 'missing').map((pkg) => pkg.id);
for (const input of inputs) if (fileHash(join(root, input.path)) !== input.sha256) throw new Error(`Source changed during inventory: ${input.path}. Retry after changes finish.`);
for (const [path, hash] of supplementalFiles) if (fileHash(path) !== hash) throw new Error(`Supplemental input changed during inventory: ${basename(path)}.`);
if (options.dryRun) {
  console.log(JSON.stringify({ dryRun: true, sourceCommit, sourceTree, releaseSourceCommit, releaseSourceTree, sourceClean: !initialStatus, buildReceiptInput, buildReceiptMetadataVerified: Boolean(buildReceipt), buildReceiptArtifactHashesVerified: false, ...inventory.counts, packagesWithoutLicenseText: missing, supplementalLicenseInputs: supplementalInputs.map(({ assignments: _assignments, ...input }) => input) }, null, 2));
  process.exit(0);
}
const app = resolve(options.app);
const dmg = resolve(options.dmg);
const out = resolve(options.out);
const plist = join(app, 'Contents/Info.plist');
const plistValue = (name) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${name}`, plist]);
if (plistValue('CFBundleShortVersionString') !== manifest.version) throw new Error('Built app version does not match source version.');
const executable = join(app, 'Contents/MacOS', plistValue('CFBundleExecutable'));
const appExecutableSha256 = fileHash(executable);
const dmgSha256 = fileHash(dmg);
verifyBuildArtifactHashes(buildReceipt, basename(dmg), dmgSha256, appExecutableSha256);
const architectures = run('lipo', ['-archs', executable]);
if (architectures !== 'arm64') throw new Error(`Expected ARM64-only app; found ${architectures}.`);
const appSignature = run('codesign', ['--display', '--verbose=4', app], { stderr: true });
if (!/^Signature=adhoc$/m.test(appSignature)) throw new Error('Expected the alpha app to have an ad-hoc signature.');
run('codesign', ['--verify', '--deep', '--strict', app]);
const dmgSignature = run('codesign', ['--display', '--verbose=4', dmg], { optional: true, stderr: true });
if (dmgSignature !== null) run('codesign', ['--verify', '--strict', dmg]);
const buildInfo = {
  format: 'docker2u-build-info/v1', product: config.productName, version: manifest.version,
  sourceCommit, sourceTree, sourceBranch: run('git', ['symbolic-ref', '--short', 'HEAD'], { optional: true }), sourceClean: true,
  releaseSourceCommit, releaseSourceTree,
  releaseTag: `v${manifest.version}`, target, architecture: architectures, minimumMacOS: config.bundle.macOS.minimumSystemVersion,
  buildToolchain: buildReceipt.toolchain,
  buildReceipt: {
    ...buildReceiptInput, sourceCommit: buildReceipt.sourceCommit, sourceTree: buildReceipt.sourceTree, version: buildReceipt.version,
    runUrl: buildReceipt.runUrl, artifacts: buildReceipt.artifacts, reportedVerification: buildReceipt.verification,
    validation: 'Supplied receipt matches the source commit/tree/version, DMG filename and SHA-256, and app executable SHA-256. Receipt origin and workflow claims are not independently authenticated by this script.',
  },
  metadataGeneratorHost: `${run('sw_vers', ['-productName'])} ${run('sw_vers', ['-productVersion'])} ${run('uname', ['-m'])}`,
  metadataGeneratorToolchain: {
    node: process.version, pnpm: run('pnpm', ['--version']), rustc: run('rustc', ['--version']), cargo: run('cargo', ['--version']),
    xcode: run('xcodebuild', ['-version'], { optional: true }),
    packages: Object.fromEntries(['@tauri-apps/cli', 'vite', 'typescript'].map((name) => {
      const directory = findPackage(name, root);
      if (!directory) throw new Error(`Build tool ${name} is not installed.`);
      return [name, readJSON(join(directory, 'package.json')).version];
    })),
  },
  inputs, supplementalLicenseMaps: supplementalInputs.map(({ assignments: _assignments, ...input }) => input), signing: 'ad-hoc', dmgSigning: dmgSignature === null ? 'unsigned' : (/^Signature=adhoc$/m.test(dmgSignature) ? 'ad-hoc' : 'other'), appleNotarized: false,
  appExecutableSha256, dmgFile: basename(dmg), dmgSha256,
  verified: ['Source HEAD and clean tree at metadata generation', 'Build receipt source commit/tree/version and artifact hash consistency', 'Release source and build source have identical Git trees', 'Application version and ARM64 architecture', 'Application ad-hoc code signature', 'Locked dependency inventory and artifact SHA-256 hashes'],
  notVerified: ['This script does not build the app or independently authenticate the supplied build receipt/workflow claims', 'DMG mounting, installation and first launch', 'Clean-machine Gatekeeper flow', 'Apple notarization', 'Runtime behavior and CI outcomes'],
};
if (run('git', ['status', '--porcelain', '--untracked-files=normal']) || run('git', ['rev-parse', 'HEAD']) !== sourceCommit) throw new Error('Source changed while generating metadata.');
if (fileHash(resolve(options['build-receipt'])) !== buildReceiptInput.sha256) throw new Error('Build receipt changed while generating metadata.');
const notices = [
  `${config.productName} third-party notices`, '', `Application version: ${manifest.version}`, `Target: ${target}`, '',
  ...Object.values(inventory.scope), '', 'Declared license expressions are copied from package metadata. See DEPENDENCIES.json for dependency edges and archive checksums.', '',
  `Packages: ${packages.size} (${inventory.counts.npm} npm; ${inventory.counts.cargo} Cargo).`, `Unique available texts: ${texts.size}.`, '',
  'Packages without packaged license/notice text (upstream supplements listed in the index below):', ...(packagedMissing.length ? packagedMissing.map((id) => `- ${id}`) : ['None']), '',
  'Packages still without any available license/notice text after supplementation:', ...(missing.length ? missing.map((id) => `- ${id}`) : ['None']), '',
  ...supplementalInputs.flatMap((input) => [`Supplemental map: ${input.file}`, `Map SHA-256: ${input.sha256}`, input.verification, '']),
  'PACKAGE INDEX', '=============', '',
  ...inventory.packages.flatMap((pkg) => [pkg.id, `Declared license: ${pkg.license ?? 'not declared'}`, `Source: ${pkg.source}`, `Repository: ${pkg.repository ?? 'not declared'}`, ...pkg.license_texts.flatMap((text) => [`Text: ${text.sha256} (${text.file}; ${text.origin ?? 'packaged'})`, ...(text.source_url ? [`Text source: ${text.source_url}`] : [])]), ...(pkg.license_texts.length ? [] : ['Text: not present in installed package or supplied upstream supplements; declared license is metadata only.']), '']),
  'LICENSE AND NOTICE TEXTS', '========================', '',
  ...[...texts].sort(([a], [b]) => a.localeCompare(b)).flatMap(([hash, content]) => [`SHA-256: ${hash}`, '', content, '']),
].join('\n');
writeFileSync(join(out, 'DEPENDENCIES.json'), `${JSON.stringify(inventory, null, 2)}\n`);
writeFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), `${notices}\n`);
writeFileSync(join(out, 'BUILD-INFO.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);
const artifactNames = [basename(dmg), 'BUILD-INFO.json', 'DEPENDENCIES.json', 'THIRD_PARTY_NOTICES.txt', 'RELEASE-NOTES.md'];
writeFileSync(join(out, 'SHA256SUMS'), artifactNames.map((name) => `${fileHash(join(out, name))}  ${name}\n`).join(''));
console.log(JSON.stringify({ out, sourceCommit, sourceTree, ...inventory.counts, artifacts: [...artifactNames, 'SHA256SUMS'] }, null, 2));
