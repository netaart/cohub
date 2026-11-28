namespace Cohub.Core;

public enum PageDialogKind { Alert, Confirm, Prompt, BeforeUnload }

public sealed class PageDialogs
{
    public delegate void Answer(bool accepted, string? text);

    private Dialog? open;

    public Dialog? Open(object page, bool shown, Answer answer)
    {
        if (open is not null || !shown)
        {
            answer(false, null);
            return null;
        }
        return open = new Dialog(this, page, answer);
    }

    public void Dismiss(object page)
    {
        if (open is { } dialog && dialog.Page == page) dialog.Settle(false);
    }

    public static string? Title(WebOrigin origin, string? frame, string unknown)
    {
        if (!Uri.TryCreate(frame, UriKind.Absolute, out var url) || url.IdnHost.Length == 0) return unknown;
        if (origin.Contains(url)) return null;
        return url.IsDefaultPort ? url.IdnHost : $"{url.IdnHost}:{url.Port}";
    }

    public static string? ReportedFrame(string? report, string message) =>
        report?.Split('\n', 2) is [var origin, var reported] && reported == message ? origin : null;

    public sealed class Dialog
    {
        private readonly PageDialogs dialogs;
        private Answer? answer;
        private Action? close;

        internal Dialog(PageDialogs dialogs, object page, Answer answer)
        {
            this.dialogs = dialogs;
            this.answer = answer;
            Page = page;
        }

        public object Page { get; }

        public bool Settled => answer is null;

        public bool Showing(Action close)
        {
            if (Settled) return false;
            this.close = close;
            return true;
        }

        public void Settle(bool accepted, string? text = null)
        {
            if (answer is not { } reply) return;
            answer = null;
            if (dialogs.open == this) dialogs.open = null;
            var shown = close;
            close = null;
            reply(accepted, accepted ? text : null);
            shown?.Invoke();
        }
    }
}
