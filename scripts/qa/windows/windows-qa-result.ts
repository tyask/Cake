import { windowsQaCodes } from './windows-qa-model';

/** Public fixed codes must stay in sync with the locally compiled broker. */
export const windowsHelperFailureCodes = [
  'WINDOWS_REQUIRED', 'WINDOWS_IDENTITY_UNAVAILABLE', 'WINDOWS_PROFILE_UNAVAILABLE', 'WINDOWS_PROFILE_CONTEXT_REJECTED', 'DIRECTORY_ALREADY_EXISTS',
  'DIRECTORY_CREATE_FAILED', 'STORE_DIRECTORY_MISSING', 'STORE_ACCESS_CHECK_FAILED', 'STORE_ACL_REJECTED',
  'TOKEN_ALREADY_EXISTS', 'REPARSE_POINT_REJECTED', 'TOKEN_FORMAT_REJECTED', 'TOKEN_EXISTS_OR_SAVE_INCOMPLETE',
  'TOKEN_SAVE_FAILED', 'TOKEN_NOT_SAVED', 'TOKEN_FILE_REJECTED', 'TOKEN_DECRYPT_FAILED', 'ARGUMENTS_REJECTED',
  'METADATA_WRITE_FAILED', 'CHILD_INTEGRITY_REJECTED', 'REQUIRED_PATH_MISSING', 'CONTROL_CHECKOUT_REJECTED',
  'NODE_EXECUTABLE_UNAVAILABLE', 'CHILD_START_FAILED', 'CHILD_TIMEOUT', 'CHILD_RESPONSE_REJECTED',
  'CHILD_EXECUTION_FAILED', 'QA_PROOF_INVALIDATION_FAILED', 'SELF_TEST_PATH_REJECTED', 'SELF_TEST_FAILED', 'OPERATION_FAILED',
] as const;

const selfTestChecks = [
  'dpapiRoundTrip', 'ciphertextHasNoDummy', 'ownerOnlyProtectedAcl', 'duplicateSaveRejectedUnchanged',
  'tamperedCipherRejected', 'unsafeAclRejected', 'childDummyMatched', 'childUnwantedEnvironmentAbsent',
  'unsafeEnvironmentFiltered', 'parentTokenPresenceUnchanged', 'tamperedChildRejectedBeforeDecrypt',
  'guiPasswordMasked', 'guiHasNoShowPasswordControl', 'guiHasNoImplicitSave', 'guiPreviewSaved',
  'failedRunnerProofInvalidated', 'existingFailedProofPreserved', 'childResponseSecretsRejected',
  'sandboxProfileRejected', 'normalProfileResolved',
  'validVerifyConfigAccepted',
] as const;
const oidcChecks = ['oidcProjectMatches', 'oidcOwnerMatches', 'oidcDevelopment', 'oidcExpiryValid'] as const;
const countLimits = {
  statusDispatchCount: 2, statusReceiptCount: 2, clickCount: 16, caseCount: 5,
  observationCount: 12, screenshotCount: 12, elapsedMs: 3_600_000,
} as const;
type QaCounts = { [Key in keyof typeof countLimits]: number };
type QaChecks = { [Key in typeof oidcChecks[number]]: boolean };
type SelfTestChecks = { [Key in typeof selfTestChecks[number]]: boolean };
type PublicFailure = { protocol: 'cake-token-helper-error/v1'; success: false; code: typeof windowsHelperFailureCodes[number] };
type PublicStatus = { protocol: 'cake-token-status/v1'; success: true; tokenSaved: boolean; aclValidated: boolean;
  tokenContentsRead: false; networkRequests: 0 };
type PublicInput = { protocol: 'cake-token-input/v1'; success: true; tokenSaved: boolean; tokenContentsRead: false; networkRequests: 0 };
type PublicSelfTest = SelfTestChecks & { protocol: 'cake-token-selftest/v1'; success: boolean; dummyOnly: true;
  networkRequests: 0; filesDeleted: false; code: 'OK' | 'SELF_TEST_FAILED' };
type PublicQa = QaChecks & { protocol: 'cake-windows-qa-child/v1'; mode: 'preflight' | 'verify'; success: boolean;
  code: typeof windowsQaCodes[number]; counts: QaCounts };
export type WindowsQaResult = PublicFailure | PublicStatus | PublicInput | PublicSelfTest | PublicQa;

function rejected(): never { throw new Error('WINDOWS_QA_RESULT_REJECTED'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) rejected();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) rejected();
}
function booleans(value: Record<string, unknown>, keys: readonly string[]) {
  if (keys.some(key => typeof value[key] !== 'boolean')) rejected();
}

/** Only reconstructed, mode-specific public fields can cross into stdout/files. */
export function parseWindowsQaResult(value: unknown, exitCode: number | null, mode: string): WindowsQaResult {
  if (!['status', 'input', 'self-test', 'preflight', 'verify'].includes(mode)) rejected();
  const result = record(value);
  if (typeof result.success !== 'boolean' || (exitCode !== 0 && exitCode !== 1) || result.success !== (exitCode === 0)) rejected();
  if (result.protocol === 'cake-token-helper-error/v1') {
    exactKeys(result, ['protocol', 'success', 'code']);
    if (result.success !== false || typeof result.code !== 'string' ||
      !(windowsHelperFailureCodes as readonly string[]).includes(result.code)) rejected();
    return { protocol: result.protocol, success: false, code: result.code as PublicFailure['code'] };
  }
  if (mode === 'status') {
    exactKeys(result, ['protocol', 'success', 'tokenSaved', 'aclValidated', 'tokenContentsRead', 'networkRequests']);
    booleans(result, ['tokenSaved', 'aclValidated']);
    if (result.protocol !== 'cake-token-status/v1' || result.success !== true || result.tokenContentsRead !== false ||
      result.networkRequests !== 0 || result.tokenSaved && !result.aclValidated) rejected();
    return { protocol: result.protocol, success: true, tokenSaved: result.tokenSaved as boolean,
      aclValidated: result.aclValidated as boolean, tokenContentsRead: false, networkRequests: 0 };
  }
  if (mode === 'input') {
    exactKeys(result, ['protocol', 'success', 'tokenSaved', 'tokenContentsRead', 'networkRequests']);
    if (result.protocol !== 'cake-token-input/v1' || result.success !== true || typeof result.tokenSaved !== 'boolean' ||
      result.tokenContentsRead !== false || result.networkRequests !== 0) rejected();
    return { protocol: result.protocol, success: true, tokenSaved: result.tokenSaved, tokenContentsRead: false, networkRequests: 0 };
  }
  if (mode === 'self-test') {
    exactKeys(result, ['protocol', 'success', 'dummyOnly', 'networkRequests', 'filesDeleted', 'code', ...selfTestChecks]);
    booleans(result, selfTestChecks);
    if (result.protocol !== 'cake-token-selftest/v1' || result.dummyOnly !== true || result.networkRequests !== 0 ||
      result.filesDeleted !== false || typeof result.code !== 'string' || !['OK', 'SELF_TEST_FAILED'].includes(result.code) ||
      result.success !== (result.code === 'OK') || result.success && selfTestChecks.some(key => result[key] !== true)) rejected();
    const checks = Object.fromEntries(selfTestChecks.map(key => [key, result[key]])) as SelfTestChecks;
    return { protocol: result.protocol, success: result.success, dummyOnly: true, networkRequests: 0,
      filesDeleted: false, code: result.code as PublicSelfTest['code'], ...checks };
  }
  exactKeys(result, ['protocol', 'mode', 'success', 'code', ...oidcChecks, 'counts']);
  booleans(result, oidcChecks);
  if (result.protocol !== 'cake-windows-qa-child/v1' || result.mode !== mode || typeof result.code !== 'string' ||
    !(windowsQaCodes as readonly string[]).includes(result.code) || result.success !== (result.code === 'OK') ||
    result.success && oidcChecks.some(key => result[key] !== true)) rejected();
  const counts = record(result.counts);
  exactKeys(counts, Object.keys(countLimits));
  for (const [key, limit] of Object.entries(countLimits))
    if (!Number.isSafeInteger(counts[key]) || Number(counts[key]) < 0 || Number(counts[key]) > limit) rejected();
  if (Number(counts.statusReceiptCount) > Number(counts.statusDispatchCount)) rejected();
  if (mode === 'preflight' && Object.keys(countLimits).some(key => key !== 'elapsedMs' && counts[key] !== 0)) rejected();
  if (mode === 'verify' && result.success && Object.entries(countLimits).some(([key, limit]) => key !== 'elapsedMs' && counts[key] !== limit)) rejected();
  const checks = Object.fromEntries(oidcChecks.map(key => [key, result[key]])) as QaChecks;
  const safeCounts = Object.fromEntries(Object.keys(countLimits).map(key => [key, counts[key]])) as QaCounts;
  return { protocol: result.protocol, mode: mode as 'preflight' | 'verify', success: result.success,
    code: result.code as PublicQa['code'], ...checks, counts: safeCounts };
}
