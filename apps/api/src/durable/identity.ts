/**
 * Headers the Worker sets on WebSocket upgrades it forwards to RunLog/ProjectRoom, after auth and
 * after stripping every client-sent `x-sf-*` header (the DOs can't see the session themselves).
 * `x-sf-machine` is also the header a daemon sends to identify itself; the Worker validates it.
 */
export const SF_HEADERS = {
  role: 'x-sf-role',
  user: 'x-sf-user',
  machine: 'x-sf-machine',
} as const;
