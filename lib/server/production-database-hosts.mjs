import config from '../../preview.config.json' with { type: 'json' };

/** Keep current, candidate and retained production endpoints outside Preview. */
export function productionDatabaseHostDigests(configuration = config) {
  const invalid = () => { throw new Error('PRODUCTION_DATABASE_HOSTS_INVALID'); };
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return invalid();
  if (!Object.hasOwn(configuration, 'productionHostDigest')) return invalid();
  const current = configuration.productionHostDigest;
  const digests = configuration.productionHostDigests === undefined ? [current] : configuration.productionHostDigests;
  if (typeof current !== 'string' || !/^[a-f0-9]{64}$/.test(current)
    || !Array.isArray(digests) || !digests.length
    || Array.from(digests).some(digest => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
    || new Set(digests).size !== digests.length || !digests.includes(current)) return invalid();
  return Object.freeze([...digests]);
}

// Validate and prepare once from the source config, independently of injected env.
const productionHosts = new Set(productionDatabaseHostDigests());
export function isProductionDatabaseHostDigest(value) {
  return typeof value === 'string' && productionHosts.has(value);
}
