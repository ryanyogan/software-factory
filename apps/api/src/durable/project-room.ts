import { DurableObject } from 'cloudflare:workers';

/**
 * One instance per project (`env.PROJECT_ROOM.getByName(projectId)`). Skeleton: a hibernatable
 * WebSocket room that relays messages to the other members. Presence/state come later.
 */
export class ProjectRoom extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Number of connected sockets (handy for tests/diagnostics). */
  async connections(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) peer.send(message);
    }
  }
}
