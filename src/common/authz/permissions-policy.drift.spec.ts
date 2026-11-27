import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSION_CATALOG, PERMISSION_CODES } from './permissions';

const POLICY_DIRECTORY = join(
  __dirname,
  '..',
  '..',
  '..',
  'cerbos',
  'policies',
);

interface ParsedPolicy {
  file: string;
  resource: string;
  actions: string[];
}

/**
 * Minimal parser for the Cerbos resource policies used by this project.
 *
 * It reads the YAML shape we control (`resourcePolicy.resource` and every
 * `actions` entry, inline or block) so the drift test does not require a new
 * runtime dependency. The source of truth for the expected codes is
 * `PERMISSION_CATALOG`; no second hand-maintained list is used.
 */
function parsePolicy(file: string): ParsedPolicy {
  const content = readFileSync(join(POLICY_DIRECTORY, file), 'utf8');
  const actions: string[] = [];
  let resource: string | undefined;
  let collectingActions = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');

    if (/^resourcePolicy:\s*$/.test(line)) {
      collectingActions = false;
      continue;
    }

    const resourceMatch = line.match(
      /^ {2}resource:\s*["']?([^"'#\s]+)["']?\s*$/,
    );
    if (resourceMatch) {
      resource = resourceMatch[1];
      collectingActions = false;
      continue;
    }

    const inlineActions = line.match(/^\s*-\s*actions:\s*\[(.*)\]\s*$/);
    if (inlineActions) {
      for (const action of inlineActions[1].split(',')) {
        const normalized = action.trim().replace(/^["']|["']$/g, '');
        if (normalized) actions.push(normalized);
      }
      collectingActions = false;
      continue;
    }

    if (/^\s*-\s*actions:\s*$/.test(line)) {
      collectingActions = true;
      continue;
    }

    if (collectingActions) {
      const blockAction = line.match(
        /^\s*-\s*["']?([A-Za-z0-9_-]+)["']?\s*$/,
      );
      if (blockAction) {
        actions.push(blockAction[1]);
      } else if (line.trim().length > 0) {
        collectingActions = false;
      }
    }
  }

  if (!resource) {
    throw new Error(`No resourcePolicy.resource found in ${file}`);
  }

  return { file, resource, actions };
}

function readPolicies(): ParsedPolicy[] {
  return readdirSync(POLICY_DIRECTORY)
    .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
    .sort()
    .map(parsePolicy);
}

describe('PERMISSION_CATALOG ↔ Cerbos policies', () => {
  const policies = readPolicies();
  const policyCodes = new Set(
    policies.flatMap((policy) =>
      policy.actions.map((action) => `${policy.resource}:${action}`),
    ),
  );
  const catalogCodes = new Set<string>(PERMISSION_CODES);

  it('tiene exactamente los mismos códigos recurso:acción', () => {
    const missingInPolicies = [...catalogCodes]
      .filter((code) => !policyCodes.has(code))
      .sort();
    const extraInPolicies = [...policyCodes]
      .filter((code) => !catalogCodes.has(code))
      .sort();

    expect({ missingInPolicies, extraInPolicies }).toEqual({
      missingInPolicies: [],
      extraInPolicies: [],
    });
  });

  it('mantiene 20 códigos únicos en el catálogo y 8 políticas', () => {
    expect(PERMISSION_CATALOG).toHaveLength(20);
    expect(catalogCodes.size).toBe(PERMISSION_CATALOG.length);
    expect(policies).toHaveLength(8);
    expect(new Set(policies.map((policy) => policy.resource)).size).toBe(
      policies.length,
    );
    expect(policies.every((policy) => policy.actions.length > 0)).toBe(true);
  });
});
