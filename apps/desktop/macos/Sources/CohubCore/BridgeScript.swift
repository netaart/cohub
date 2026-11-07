public enum BridgeScript {
    public static let receive = "window.__cohubHostReceive?.(data)"

    public static let source = """
    (() => {
      const handler = window.webkit?.messageHandlers?.\(HostProtocol.global);
      if (!handler || window.\(HostProtocol.global)) return;
      const listeners = new Set();
      Object.defineProperty(window, "__cohubHostReceive", {
        value: (data) => {
          for (const listener of listeners) {
            try { listener({ data }); } catch (error) { console.error(error); }
          }
        },
      });
      Object.defineProperty(window, "\(HostProtocol.global)", {
        value: Object.freeze({
          postMessage: (message) => handler.postMessage(String(message)),
          addEventListener: (type, listener) => { if (type === "message") listeners.add(listener); },
          removeEventListener: (type, listener) => { if (type === "message") listeners.delete(listener); },
        }),
      });
    })();
    """
}
