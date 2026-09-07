// One-time import from the pinned, separately fetched source tree. Never runs at application startup.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const commit = 'c695f855419ffc69d1e62b04f1de8de36c7c162d';
const sourceRoot = resolve('.local/upstream/carried');
const pairs = [
  ['contracts/model-contract', 'contracts/model'],
  ['contracts/model-adapter-capabilities', 'contracts/model-capabilities'],
  ['contracts/plain-json', 'contracts/plain-json'],
  ['providers/openai-subscription-adapter', 'providers/codex/adapter'],
  ['providers/openai-subscription-transport', 'providers/codex/transport'],
  ['providers/codex-responses-compatibility', 'providers/codex/compatibility'],
  ['providers/codex-responses-parser', 'providers/codex/responses-parser'],
  ['providers/codex-function-call-state', 'providers/codex/function-call-state'],
  ['providers/openai-subscription-model-catalog', 'providers/codex/model-catalog'],
  ['providers/model-adapter', 'providers/shared/adapter'],
  ['providers/model-catalog', 'providers/shared/catalog'],
  ['providers/model-input-safety', 'providers/shared/input-safety'],
  ['providers/redaction', 'shared/redaction'],
  ['auth/oauth', 'auth/codex-oauth'],
];
const locations = new Map(pairs.map(([source, target]) => [source.split('/')[1], `src/${target}.ts`]));
const entries = [];
for (const [source, target] of pairs) {
  const [area, basename] = source.split('/');
  const originalPath = `core/${area}/src/${basename}.ts`;
  // Read immutable git blobs, not a possibly modified checkout.
  const original = execFileSync('git', ['-C', sourceRoot, 'show', `${commit}:${originalPath}`], { encoding: 'utf8', maxBuffer: 2_000_000 });
  const path = `src/${target}.ts`;
  const importPath = (destination) => {
    const value = relative(dirname(path), destination).replaceAll('\\', '/');
    return value.startsWith('.') ? value : `./${value}`;
  };
  let body = original.replaceAll("'@carried/contracts'", `'${importPath('src/contracts/index.ts')}'`)
    .replaceAll("'@carried/auth'", `'${importPath('src/auth/credential-store.ts')}'`)
    .replace(/'\.\/([^']+)\.js'/g, (match, name) => {
      const location = locations.get(name) ?? ({ 'model-profile': 'src/providers/shared/profile.ts', 'credential-store': 'src/auth/credential-store.ts' })[name];
      if (!location) throw new Error(`Unresolved import ${match} in ${path}`);
      return `'${importPath(location)}'`;
    })
    .replaceAll('supports_carried_tool_loop', 'supports_niwa_tool_loop')
    .replaceAll('CARRIED_REASONING_EFFORTS', 'NIWA_REASONING_EFFORTS')
    .replaceAll('CARRIED_TOOL_LOOP', 'NIWA_TOOL_LOOP');
  if (target === 'providers/shared/adapter') {
    body = body.replace('  RuntimeName,\n', '').replace(/export type ModelRole =[\s\S]*?\nfunction toAsyncIterator/, 'function toAsyncIterator');
  }
  if (target === 'auth/codex-oauth') {
    body = body.replace("import { spawn } from 'node:child_process';\n", '')
      .replace("originator: 'carried'", "originator: 'niwa'")
      .replace('    const openExternal = config.open_external ?? openExternalUrl;',
        "    const openExternal = config.open_external;\n    if (!openExternal) throw new OAuthError('INVALID_CONFIG', 'Niwa requires a host-owned login URL handler.');")
      .replace(/async function openExternalUrl\([\s\S]*?\nfunction base64Url/, 'function base64Url');
  }
  if (target === 'providers/codex/transport') {
    body = body.replace("DEFAULT_SUBSCRIPTION_ORIGINATOR = 'carried'", "DEFAULT_SUBSCRIPTION_ORIGINATOR = 'niwa'")
      .replace("DEFAULT_SUBSCRIPTION_USER_AGENT = 'carried/0.1'", "DEFAULT_SUBSCRIPTION_USER_AGENT = 'niwa/0.1'");
  }
  mkdirSync(dirname(path), { recursive: true });
  const contents = `// Derived from Carried ${commit}, ${originalPath}.\n// Apache-2.0. Modified for Niwa; see THIRD_PARTY_NOTICES.md and provenance/carried.json.\n${body}`;
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== contents) throw new Error(`Refusing to overwrite changed ${path}; apply upstream updates as reviewed diffs.`);
  } else writeFileSync(path, contents);
  entries.push({ source: originalPath, target: path, source_sha256: createHash('sha256').update(original).digest('hex') });
}
mkdirSync('provenance', { recursive: true });
writeFileSync('provenance/carried.json', JSON.stringify({ repository: 'https://github.com/Armeria-SK/Carried', commit, files: entries }, null, 2) + '\n');
