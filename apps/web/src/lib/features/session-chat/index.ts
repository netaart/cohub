/**
 * session-chat public surface.
 * Prefer this barrel for host/shell integration; internal controllers stay private.
 */
export {
	createSessionChatHost,
	type SessionChatHost,
	type SessionChatHostOptions,
} from "./session-chat-host.controller.svelte.ts";
export { getSessionTitle } from "./session-utils.ts";
export { subscribeSpaceChannel } from "./space-channel.ts";
