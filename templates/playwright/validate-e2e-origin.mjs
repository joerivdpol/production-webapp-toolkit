/**
 * Fail closed unless E2E targets a loopback or reserved test-only origin.
 * Keep production-facing test authorization outside this default helper.
 *
 * @param {string} value
 * @returns {URL}
 */
export function validateE2EOrigin(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    throw new Error(`E2E_BASE_URL must be an absolute URL; received ${JSON.stringify(value)}`);
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error(`E2E target must use HTTP(S); received ${target.protocol}`);
  }
  if (target.username || target.password) {
    throw new Error('E2E target must not contain credentials');
  }

  const hostname = target.hostname.toLowerCase().replace(/\.$/, '');
  const isLoopback = hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  const isReservedTestHost = hostname.endsWith('.test') || hostname.endsWith('.localhost');
  if (!isLoopback && !isReservedTestHost) {
    throw new Error(`Refusing non-local/non-test E2E origin: ${target.origin}`);
  }
  if (target.pathname !== '/' || target.search || target.hash) {
    throw new Error('E2E_BASE_URL must be an origin without a path, query, or fragment');
  }
  return target;
}
