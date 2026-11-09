// Offline, redacted reconciliation planner. NO network, DB driver, env secrets,
// SQL execution or gate activation. Input is an owner-authored normalized export,
// NOT a guessed adapter for the unknown legacy schema. CLI is dry-run only.
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
function requireValue(ok, code) { if (!ok) throw new Error(code); }
function fields(value, names) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...names].sort().join(','), 'INVALID_FIELDS');
}
function ref(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value); }

export function planCutover(input) {
  fields(input, ['contract', 'snapshot', 'historicalUsed', 'usageReference', 'records', 'approvals']);
  requireValue(input.contract === 'mark-legacy-reconciliation-v1', 'INVALID_CONTRACT');
  fields(input.snapshot, ['reference', 'sha256', 'complete', 'rowCount']);
  requireValue(ref(input.snapshot.reference) && typeof input.snapshot.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(input.snapshot.sha256), 'SNAPSHOT_EVIDENCE_REQUIRED');
  requireValue(input.snapshot.complete === true && Number.isSafeInteger(input.snapshot.rowCount) &&
    input.snapshot.rowCount >= 0, 'COMPLETE_SNAPSHOT_REQUIRED');
  requireValue(Number.isSafeInteger(input.historicalUsed) && input.historicalUsed >= 0 &&
    input.historicalUsed <= 2147483647 && ref(input.usageReference), 'VERIFIED_USAGE_REQUIRED');
  requireValue(Array.isArray(input.records) && input.records.length === input.snapshot.rowCount &&
    input.records.length <= 100000, 'SNAPSHOT_COUNT_MISMATCH');
  const ids = new Set(), targets = new Set(), identities = new Set();
  let freeRows = 0, imported = 0, retained = 0;
  const mapping = input.records.map(row => {
    // Contacts are expressly rejected: this plan must be safe to share/log.
    fields(row, ['legacyId', 'targetId', 'grader', 'cert', 'status', 'free', 'disposition', 'reference']);
    requireValue(ref(row.legacyId) && !ids.has(row.legacyId), 'DUPLICATE_OR_INVALID_LEGACY_ID');
    ids.add(row.legacyId);
    requireValue(['PSA', 'CGC'].includes(row.grader) && typeof row.cert === 'string' &&
      /^[1-9][0-9]{5,9}$/.test(row.cert), 'RESOLVED_IDENTITY_REQUIRED');
    const identity = `${row.grader}:${row.cert}`;
    // Even retained legacy records must not collide: v2 otherwise accepts a
    // previously fulfilled/rejected cert as new. Requires explicit resolution.
    requireValue(!identities.has(identity), 'AMBIGUOUS_IDENTITY'); identities.add(identity);
    requireValue(typeof row.free === 'boolean' && ref(row.status) && ref(row.reference), 'ORIGINAL_DECISION_REQUIRED');
    if (row.free) freeRows++;
    if (row.disposition === 'import-requested') {
      requireValue(row.status === 'requested' && typeof row.targetId === 'string' && uuid.test(row.targetId) &&
        !targets.has(row.targetId), 'INVALID_IMPORT_MAPPING');
      targets.add(row.targetId); imported++;
    } else {
      requireValue(row.disposition === 'retain-legacy' && row.targetId === null, 'INVALID_DISPOSITION');
      retained++;
    }
    return { ...row };
  });
  requireValue(input.historicalUsed >= freeRows, 'USAGE_BELOW_PRESERVED_FREE_DECISIONS');
  const approvalNames = ['schemaReview', 'policy', 'identityContactRules', 'legacyWriteFreeze',
    'legacyGrantClosure', 'contactOperations', 'abuseControls', 'gatewayPrivileges', 'stagingRehearsal'];
  fields(input.approvals, approvalNames);
  const missing = approvalNames.filter(name => !ref(input.approvals[name]));
  for (const value of Object.values(input.approvals)) requireValue(value === null || ref(value), 'INVALID_APPROVAL_REFERENCE');
  const blockers = missing.map(name => `MISSING_${name}`);
  // Existing v2 has no exclusion/tombstone path for retained records. Never
  // report a safe cutover when legacy-only statuses can be resubmitted as new.
  if (retained) blockers.push('RETAINED_IDENTITIES_NEED_APPROVED_EXCLUSION_MAPPING');
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return { contract: 'mark-cutover-dry-run-v1', inputSha256: digest,
    historicalUsed: input.historicalUsed, freeRows, imported, retained, mapping,
    blockers, evidenceComplete: blockers.length === 0,
    // Even complete owner assertions cannot prove staging or authorize launch.
    publicIntakeEnabled: false, paymentsEnabled: false, activationAuthorized: false };
}

export async function main(args) {
  if (args.length !== 2 || args[0] !== '--dry-run') throw new Error('USAGE: mark-cutover.mjs --dry-run redacted-manifest.json');
  // Bound bytes before JSON parsing; refuse symlinks/huge arbitrary exports.
  const { open } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const file = await open(args[1], constants.O_RDONLY | constants.O_NOFOLLOW);
  let data;
  try {
    const stat = await file.stat();
    requireValue(stat.isFile() && stat.size <= 16 * 1024 * 1024, 'MANIFEST_SIZE_LIMIT');
    const buffer = Buffer.alloc(16 * 1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    requireValue(length < buffer.length, 'MANIFEST_SIZE_LIMIT');
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } finally { await file.close(); }
  const plan = planCutover(data);
  // Default output deliberately excludes certs/IDs, not just contact addresses.
  const { mapping, ...summary } = plan;
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return plan.evidenceComplete ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    // Never print input, filenames, parser excerpts or supplied values.
    const known = /^[A-Z_]+$/.test(error.message) ? error.message : 'INVALID_MANIFEST_OR_ARGUMENTS';
    process.stderr.write(`Mark dry-run refused: ${known}\n`); process.exitCode = 1;
  }
}
