import { WebsocketDisconnectedError, type WebsocketClient } from "./websocket.js";

export function ensureRealtimeConnected(websocketClient: WebsocketClient) {
  if (websocketClient.state === "open" || websocketClient.state === "connecting" || websocketClient.state === "reconnecting") {
    return;
  }
  void websocketClient.connect().catch((error) => {
    if (error instanceof WebsocketDisconnectedError) return;
    console.error("[CohubClient] Failed to connect realtime websocket:", error);
  });
}
