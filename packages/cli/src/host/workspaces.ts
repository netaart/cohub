import { HOST_BRIDGE_ERROR, HostBridgeErrorClass, type HostWorkspaceCallResult } from "@neta-art/cohub/host-bridge";
import { LocalWorkspaceRpcError, LocalWorkspaceUnavailableError, type LocalWorkspaceMethod } from "@neta-art/cohub";
import { connectLocalWorkspace, findLocalWorkspace } from "../runtime/local-workspace.js";

export async function callLocalWorkspace(spaceId: string, method: string, params: unknown): Promise<HostWorkspaceCallResult> {
  const endpoint = await findLocalWorkspace(spaceId);
  if (endpoint) {
    try {
      return { result: await connectLocalWorkspace(endpoint).call(method as LocalWorkspaceMethod, params ?? {}) };
    } catch (error) {
      if (error instanceof LocalWorkspaceRpcError) return { error: { code: error.rpcErrorCode, message: error.message.slice(0, 4_000) } };
      if (!(error instanceof LocalWorkspaceUnavailableError)) throw error;
    }
  }
  throw new HostBridgeErrorClass(HOST_BRIDGE_ERROR.unavailable, "This device does not serve that Space");
}
