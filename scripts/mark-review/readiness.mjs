// Offline source-contract guard only. No database, environment, network, or apply mode.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url);
const paths = Object.freeze({
  intake: 'functions/api/mark-request.js',
  schema: 'supabase/migrations/20261107_mark_intake_v2.sql',
  gate: 'supabase/migrations/20261107_mark_intake_gate.sql',
  contacts: 'supabase/migrations/20261107_mark_contact_ops.sql',
  publicMarks: 'supabase/migrations/20261026_a5_public_marks.sql',
  payment: 'functions/api/stripe-webhook.js',
  signing: 'operations/mark-signing.template.html',
  republisher: 'scripts/republish_marks.mjs'
});

export async function readSources() {
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) =>
    [key, await readFile(new URL(path, root), 'utf8')])));
}

// This is a narrow textual regression guard, NOT a SQL parser, privilege audit,
// deployed-schema check, or certification of arbitrary edited source as safe.
export function inspectSources(sources) {
  const checks = {
    requestedOnlySchema: /status text not null default 'requested' check \(status = 'requested'\)/.test(sources.schema),
    requestedOnlyHandler: /d\.status !== 'requested'/.test(sources.intake),
    privateRequestsRls: /alter table mark_intake_private\.requests enable row level security/.test(sources.schema),
    duplicateDoesNotUpdateContact: /if not was_existing then[\s\S]*insert into mark_intake_private\.requests/.test(sources.schema) &&
      !/update\s+mark_intake_private\.requests/i.test(sources.schema),
    intakeRequiresThreeBindings: ['MARK_INTAKE_RPC_TOKEN', 'MARK_INTAKE_API_KEY', 'MARK_INTAKE_GATE']
      .every(name => sources.intake.includes(`!env?.${name}`)),
    publicGetUsesAggregateRpc: /rpc\(env, 'mark_intake_status_v2', \{\}\)/.test(sources.intake),
    gateOverloadGrantedToAnon: /grant execute on function public\.claim_mark_v2\(text,text,text,text\), public\.mark_intake_status_v2\(text\) to anon/.test(sources.gate),
    contactOperationsPrivate: /security invoker/.test(sources.contacts) && /from public, anon, authenticated, service_role, mark_intake_rpc/.test(sources.contacts),
    paymentSourceDisabled: /const PAYMENTS_AVAILABLE = false;/.test(sources.payment),
    publicMarksVisiblePolicy: /for select to anon, authenticated using \(visible\)/.test(sources.publicMarks),
    signingRequiresPerCardConfirmation: /assert\(\$\('#review-'\+i\)\.checked/.test(sources.signing) && /eth_sendTransaction/.test(sources.signing),
    separateRepublisherCanPublish: /Wallet\.fromEncryptedJson/.test(sources.republisher) && /reg\.publish\(/.test(sources.republisher)
  };
  const matched = sources.intake.match(/const INTAKE_AVAILABLE = (true|false);/);
  return {
    contract: 'mark-review-source-readiness-v1',
    scope: 'local-source-only',
    sourceIntakeGate: matched ? matched[1] === 'true' : null,
    checks,
    sourceContractMatches: Object.values(checks).every(Boolean) && !!matched,
    // No references supplied by callers can turn local inspection into approval.
    phase7Ready: false,
    backendDeploymentAuthorized: false,
    blockers: [
      'DEPLOYED_SCHEMA_AND_CONFIG_NOT_VERIFIED',
      'REQUEST_STATUS_CONSTRAINT_ONLY_REQUESTED',
      'REVIEW_ROLE_AUTHORIZATION_AND_AUDIT_NOT_IMPLEMENTED',
      'REQUESTER_STATUS_ACCESS_CONTRACT_NOT_APPROVED',
      'SIGNING_AND_PUBLICATION_NOT_LINKED_TO_REVIEW'
    ]
  };
}

export async function main(args) {
  if (args.length !== 1 || args[0] !== '--check') throw new Error('INVALID_ARGUMENTS');
  const report = inspectSources(await readSources());
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  // 2 = expected blocked readiness, 1 = source drift/invalid invocation, never launch approval.
  return report.sourceContractMatches ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch { process.stderr.write('Mark review check refused: INVALID_ARGUMENTS_OR_SOURCE\n'); process.exitCode = 1; }
}
