// Only transport/missing-controller failures offer service recovery. Identity,
// configuration and project validation failures must retain their own diagnosis.
export function isBackendDisconnected(error) {
  return ['controller_unavailable','upstream_unavailable'].includes(error?.code);
}
export function backendReadError(error) {
  if(isBackendDisconnected(error))return '工程服务未连接，暂时无法读取工程。请连接工程服务后重试。';
  return error?.message || '工程状态读取失败，请重新读取。';
}
