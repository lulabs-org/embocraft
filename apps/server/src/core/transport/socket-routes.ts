import type WebSocket from 'ws';
import type { IncomingMessage } from 'node:http';

/** Shared socket contracts: modules and transport both speak this route shape. */
export type SocketHandler = (socket: WebSocket, req: IncomingMessage) => void;
export type SocketRoutes = Map<string, SocketHandler>;
