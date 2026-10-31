using System.Windows.Interop;

namespace Cohub;

internal sealed class GlobalShortcut : IDisposable
{
    private const int Id = 1;
    private const int WmHotkey = 0x0312;
    private const uint ModAlt = 0x0001, ModControl = 0x0002, ModNoRepeat = 0x4000, VkSpace = 0x20;

    private readonly Action action;
    private bool registered;

    public GlobalShortcut(Action action)
    {
        this.action = action;
        ComponentDispatcher.ThreadFilterMessage += OnMessage;
    }

    public void Set(bool enabled)
    {
        if (enabled == registered) return;
        if (enabled) registered = Native.RegisterHotKey(IntPtr.Zero, Id, ModAlt | ModControl | ModNoRepeat, VkSpace);
        else
        {
            Native.UnregisterHotKey(IntPtr.Zero, Id);
            registered = false;
        }
    }

    private void OnMessage(ref MSG message, ref bool handled)
    {
        if (message.message != WmHotkey || (int)message.wParam != Id) return;
        action();
        handled = true;
    }

    public void Dispose()
    {
        Set(false);
        ComponentDispatcher.ThreadFilterMessage -= OnMessage;
    }
}
