import {validateTaskContract,taskDeadline} from '../core/task-contract.mjs';

const MIN_AGE = 120_000;
const compact = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const unresolved = row => ['executing', 'unknown'].includes(row.status) && !row.resolution;

// This handle is assembled only from the running task, its authenticated ingress,
// the current device lease, and the installed app scope. It is never a tool argument.
export function controllerReturnAuthority(phone, deviceId, operation, packageName, signal) {
  if (!['launch', 'general_scroll', 'general_tap'].includes(operation) || !signal || signal.aborted || !phone.phoneUse?.client?.remoteTransport) return null;
  const taskId = phone.lease;
  const task = phone.store.data.tasks.find(row => row.id === taskId);
  const grant = task?.phoneUseScope;
  if (!grant || grant.mode !== 'general' || grant.modelSelected || grant.effectPlan || grant.packageName !== packageName) return null;
  const epoch = task.remoteControlEpoch;
  const ingress = task.crossEnd?.origin;
  const message = task.messages.find(row => row.id === grant.sourceMessageId && row.role === 'user');
  if (!Number.isSafeInteger(epoch) || epoch < 0 || !ingress || ingress.endpoint !== 'phone' || ingress.deviceId !== task.remoteDeviceId || message?.crossEndOrigin?.endpoint !== 'phone' || message.crossEndOrigin.deviceId !== ingress.deviceId || !message.inputDigest || message.clientRequestId !== task.clientRequestId) return null;
  const telemetry = phone.remoteDeviceTelemetry?.();
  if (telemetry?.fresh !== true || !telemetry.certificateFingerprint || telemetry.deviceId !== ingress.deviceId) return null;
  const bindingId=ingress.deviceId, fingerprint=telemetry.certificateFingerprint, messageId=message.id, requestId=message.clientRequestId, digest=message.inputDigest;
  const submittedAt = Date.parse(task.timeline?.submittedAt);
  const createdAt = Date.parse(task.createdAt);
  const contract = task.taskContract;
  if (!(Date.parse(task.remoteExpiresAt) > phone.clock())) return null;
  if (!contract || !Number.isFinite(submittedAt) || !Number.isFinite(createdAt) || !contract.allowedApps?.some(app => compact(app) === compact(grant.appName))) return null;
  const contractId=contract.id, revision=contract.revision;
  const key = JSON.stringify([taskId, messageId, contractId, revision, bindingId, fingerprint, epoch, packageName]);
  function valid(old) {
    const live = phone.store.data.tasks.find(row => row.id === taskId);
    const scope = live?.phoneUseScope;
    const control = phone.remoteControlState?.();
    const bound = phone.remoteDeviceTelemetry?.();
    const now = phone.clock();
    if (signal.aborted || phone.lease !== taskId || phone.remoteMaintenance || phone.store.data.settings.phoneEnabled === false || phone.store.data.settings.phoneUseDeviceId !== deviceId || control?.paused !== false || control.controlEpoch !== epoch || bound?.fresh !== true || bound.deviceId !== bindingId || bound.certificateFingerprint !== fingerprint) return false;
    if (!(taskDeadline(live||{}) > now) || live?.status !== 'running' || live.source !== 'user' || live.parentId || live.groupContext || live.remoteControlEpoch !== epoch || live.remoteDeviceId !== bindingId || live.crossEnd?.lastEndpoint?.endpoint !== 'phone' || live.crossEnd.lastEndpoint.deviceId !== bindingId || live.clientRequestId !== requestId) return false;
    const originalMessage=live.messages.find(row=>row.id===messageId);
    if(live.crossEnd?.origin?.endpoint!=='phone'||live.crossEnd.origin.deviceId!==bindingId||originalMessage?.role!=='user'||originalMessage.externalContent||originalMessage.external_content||originalMessage.interjection||originalMessage.clientRequestId!==requestId||originalMessage.inputDigest!==digest||originalMessage.crossEndOrigin?.endpoint!=='phone'||originalMessage.crossEndOrigin.deviceId!==bindingId)return false;
    const checked = validateTaskContract(live, {store: phone.store, at: now});
    if (!checked.valid || checked.contract.id !== contractId || checked.contract.revision !== revision || !checked.contract.effects.includes('read') || !checked.contract.effects.includes('navigate') || checked.contract.effects.some(effect => !['read', 'navigate'].includes(effect))) return false;
    if (scope?.mode !== 'general' || scope.modelSelected || scope.effectPlan || scope.packageName !== packageName || scope.sourceMessageId !== messageId || scope.contractId !== contractId || scope.contractRevision !== revision) return false;
    // A refused later launch stores the blocking request ID as its reason.
    // Only rows that actually dispatched can be the original native action.
    const rows = phone.store.data.actions.filter(row => row.nativeRequestId === old.requestId && row.status !== 'not_executed');
    if (rows.length !== 1) return false;
    const original = rows[0];
    const owner = phone.store.data.tasks.find(row => row.id === original.taskId);
    const finished = Date.parse(original.finishedAt);
    return old.deviceId === deviceId && old.tool === 'back' && old.state === 'unknown' && !old.resolution && now - old.createdAt >= MIN_AGE &&
      original.tool === 'phone_action' && original.phoneOperation === 'back' && original.authorization === 'general_navigation' && original.status === 'unknown' && !original.resolution && !original.phoneEffect && !original.collaborationEffect &&
      owner?.status === 'unknown_result' && !!(owner.taskContract?.goal || owner.prompt) && owner.id !== taskId && (!owner.remoteDeviceId || owner.remoteDeviceId === bindingId) && compact(owner.taskContract?.goal || owner.prompt) !== compact(checked.contract.goal) &&
      Number.isFinite(finished) && now - finished >= MIN_AGE && submittedAt - finished >= MIN_AGE && createdAt - finished >= MIN_AGE && Date.parse(message.at) > finished &&
      phone.store.data.actions.filter(row => row.taskId === owner.id && unresolved(row)).length === 1 && !phone.store.data.actions.some(row => row.taskId === taskId && row.status === 'unknown' && !row.resolution);
  }
  return {key, operation, packageName, taskId, epoch, createdAt, valid, used:()=>phone.store.data.tasks.find(row=>row.id===taskId)?.events?.some(event=>event.type==='phone_controller_return'), record(proof) {
    phone.store.event(taskId, 'phone_controller_return', '已观察到绑定手机的控制器前台，新的应用导航独立核验', {originalRequestId: proof.requestId, newRequestId: proof.newRequestId, observationId: proof.observationId, controlEpoch: epoch, targetPackage: packageName});
  }};
}
