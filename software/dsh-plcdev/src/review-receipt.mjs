import path from 'node:path';

const ID = /^user-[0-9a-f]{32}$/;
const TASK = /^task-[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const REQUEST = /^[A-Za-z0-9_-]{1,100}$/;
const fields = (value,names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(k => Object.hasOwn(value,k));
const requestFields = ['projectId','taskId','candidateDigest','expectedRevision','action','clientRequestId'];
const responseFields = ['ok','projectId','taskId','candidateDigest','clientRequestId','state','reasonCode','keptProjectId','manifestPath','revision'];
const unknownReasons = new Set(['operation_in_progress','receipt_unconfirmed','receipt_mismatch','copy_changed','index_unavailable','index_conflict','evidence_unavailable']);

export function validKeepReceiptRequest(value) {
  return fields(value,requestFields) && typeof value.projectId === 'string' && ID.test(value.projectId)
    && typeof value.taskId === 'string' && TASK.test(value.taskId)
    && typeof value.candidateDigest === 'string' && HASH.test(value.candidateDigest)
    && typeof value.expectedRevision === 'string' && HASH.test(value.expectedRevision)
    && value.action === 'keep' && typeof value.clientRequestId === 'string' && REQUEST.test(value.clientRequestId);
}

export function validKeepReceipt(value, request) {
  const saved=value?.completionScope==='saved-project-version';
  if (!validKeepReceiptRequest(request) || !fields(value,saved?[...responseFields,'completionScope','version']:responseFields) || value.ok !== true
      || ['projectId','taskId','candidateDigest','clientRequestId'].some(k=>value[k]!==request[k])) return false;
  if (value.state === 'unknown')
    return !saved && unknownReasons.has(value.reasonCode) && value.keptProjectId === null && value.manifestPath === null && value.revision === null;
  return ['confirmed_registered','confirmed_unregistered'].includes(value.state) && value.reasonCode === 'none'
    && (saved ? value.keptProjectId===request.projectId && Number.isSafeInteger(value.version) && value.version>=2 : value.keptProjectId!==request.projectId)
    && typeof value.keptProjectId === 'string' && ID.test(value.keptProjectId)
    && typeof value.manifestPath === 'string' && value.manifestPath.length <= 4096 && !/[\x00-\x1f]/.test(value.manifestPath)
    && path.isAbsolute(value.manifestPath) && typeof value.revision === 'string' && HASH.test(value.revision);
}
