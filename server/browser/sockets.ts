/**
 * One Bun server has one WebSocket handler: the relay's sockets (`/api/relay/v1`) and remote control's
 * (`/api/control/v1`) share it, told apart by the state each upgrade gives them (`kind: 'control'`).
 */
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import type { ControlService, ControlSocketData } from './control';
import type { RelayService, RelaySocketData } from './relay';
import { RELAY_MAX_FRAME_BYTES } from '../../src/browser/relay-crypto';

export type ServiceSocketData = RelaySocketData | ControlSocketData;
const isControl = (ws: ServerWebSocket<ServiceSocketData>): ws is ServerWebSocket<ControlSocketData> => (ws.data as Partial<ControlSocketData>).kind === 'control';

/** The handler for both, each optional: a socket of a service that isn't there is closed at once. */
export function serviceWebsocket(relay?: RelayService, control?: ControlService): WebSocketHandler<ServiceSocketData> {
  const relayHandler = relay?.websocket, controlHandler = control?.websocket;
  const missing = (ws: ServerWebSocket<ServiceSocketData>) => { try { ws.close(1011, 'unavailable'); } catch { /* Closed. */ } };
  return {
    // Both carry the relay's envelopes, so both take the same frame size and idle time.
    maxPayloadLength: RELAY_MAX_FRAME_BYTES + 4096,
    idleTimeout: 75,
    open: ws => {
      if (isControl(ws)) { if (controlHandler?.open) controlHandler.open(ws); else missing(ws); }
      else if (relayHandler?.open) relayHandler.open(ws as ServerWebSocket<RelaySocketData>); else missing(ws);
    },
    message: (ws, message) => {
      if (isControl(ws)) void controlHandler?.message?.(ws, message);
      else void relayHandler?.message?.(ws as ServerWebSocket<RelaySocketData>, message);
    },
    drain: ws => { if (!isControl(ws)) relayHandler?.drain?.(ws as ServerWebSocket<RelaySocketData>); },
    close: (ws, code, reason) => {
      if (isControl(ws)) controlHandler?.close?.(ws, code, reason);
      else relayHandler?.close?.(ws as ServerWebSocket<RelaySocketData>, code, reason);
    },
  };
}
