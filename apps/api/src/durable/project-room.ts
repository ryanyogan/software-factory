import { DurableObject } from 'cloudflare:workers';
import type { ProjectNotice } from '@sf/contract';
import { SF_HEADERS } from './identity';

/** Per-socket identity (set by the Worker route after auth). `daemon` when `x-sf-machine` was sent. */
export interface ProjectRoomSocket {
  role: 'viewer' | 'daemon';
  userId: string;
  machineId: string | null;
}

/**
 * One instance per project (`env.PROJECT_ROOM.getByName(projectId)`). Server → client fan-out of
 * `ProjectNotice`s (run.queued, run.state, run.message, run.cancel_requested) so daemons learn of
 * local work without polling. Clients only send `ping` (auto-answered `pong`); anything else is ignored.
 */
export class ProjectRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const userId = request.headers.get(SF_HEADERS.user);
    if (!userId) return new Response('missing identity', { status: 400 });
    const machineId = request.headers.get(SF_HEADERS.machine);
    const role = machineId ? 'daemon' : 'viewer';
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, userId, machineId } satisfies ProjectRoomSocket);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Send a notice to every socket (or only those tagged `role`). Returns how many got it. */
  async broadcast(notice: ProjectNotice, role?: ProjectRoomSocket['role']): Promise<number> {
    const msg = JSON.stringify(notice);
    let n = 0;
    for (const ws of this.ctx.getWebSockets(role)) {
      try {
        ws.send(msg);
        n++;
      } catch {
        // socket already closing; ignore
      }
    }
    return n;
  }

  /** Connected sockets by role (diagnostics/tests). */
  async connections(): Promise<{ viewer: number; daemon: number }> {
    return {
      viewer: this.ctx.getWebSockets('viewer').length,
      daemon: this.ctx.getWebSockets('daemon').length,
    };
  }

  override async webSocketMessage(): Promise<void> {
    // Server → client only. (`ping` is answered by the auto-response without waking the DO.)
  }
}
