using System.Drawing;
using System.Windows.Forms;
using Cohub.Core;

namespace Cohub;

internal sealed class TrayIcon : IDisposable
{
    internal sealed record Actions(
        Action ShowCohub,
        Action NewWindow,
        Action<string> OpenSpace,
        Action<string> Disconnect,
        Action NewSpace,
        Action StopSharing,
        Action InstallCommandLineTool,
        Action RestartToUpdate,
        Action Quit);

    private readonly NotifyIcon icon = new() { Text = "Cohub" };
    private readonly Icon plain;
    private readonly Actions actions;
    private RuntimeOverview overview = RuntimeOverview.Empty;
    private bool updateReady;
    private bool sharing;
    private Icon? badged;

    public TrayIcon(Icon plain, Actions actions)
    {
        this.plain = plain;
        this.actions = actions;
        icon.Icon = plain;
        icon.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) actions.ShowCohub(); };
        Rebuild();
        icon.Visible = true;
    }

    public void Update(RuntimeOverview next)
    {
        if (next.Equals(overview)) return;
        overview = next;
        Rebuild();
    }

    public void UpdateSharing(bool next)
    {
        if (next == sharing) return;
        sharing = next;
        Rebuild();
    }

    public void UpdateReady()
    {
        updateReady = true;
        Rebuild();
    }

    private void Rebuild()
    {
        var menu = new ContextMenuStrip();
        var connected = overview.Connected;
        if (sharing)
        {
            menu.Items.Add(new ToolStripLabel(Strings.L("Sharing this screen")) { ForeColor = SystemColors.GrayText });
            menu.Items.Add(Strings.L("Stop Sharing"), null, (_, _) => actions.StopSharing());
            menu.Items.Add(new ToolStripSeparator());
        }
        if (connected.Count > 0)
        {
            menu.Items.Add(new ToolStripLabel(Strings.L("Connected Folders")) { ForeColor = SystemColors.GrayText });
            foreach (var folder in connected)
            {
                var entry = new ToolStripMenuItem(folder.Name) { Image = Dot(folder.State, 12), ToolTipText = folder.Label };
                entry.DropDownItems.Add(new ToolStripLabel(folder.Label) { ForeColor = SystemColors.GrayText });
                entry.DropDownItems.Add(new ToolStripLabel(Describe(folder.State)) { ForeColor = SystemColors.GrayText });
                entry.DropDownItems.Add(new ToolStripSeparator());
                entry.DropDownItems.Add(Strings.L("Open Space"), null, (_, _) => actions.OpenSpace(folder.SpaceId));
                entry.DropDownItems.Add(Strings.L("Show in File Explorer"), null, (_, _) => System.Diagnostics.Process.Start("explorer.exe", $"\"{folder.Root}\"")?.Dispose());
                entry.DropDownItems.Add(new ToolStripSeparator());
                entry.DropDownItems.Add(Strings.L("Disconnect"), null, (_, _) => actions.Disconnect(folder.SpaceId));
                menu.Items.Add(entry);
            }
            menu.Items.Add(new ToolStripSeparator());
        }
        var open = new ToolStripMenuItem(Strings.L("Open Cohub"), null, (_, _) => actions.ShowCohub()) { Font = new Font(menu.Font, System.Drawing.FontStyle.Bold) };
        menu.Items.Add(open);
        menu.Items.Add(Strings.L("New Window"), null, (_, _) => actions.NewWindow());
        menu.Items.Add(Strings.L("New Space…"), null, (_, _) => actions.NewSpace());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Strings.L("Install Command Line Tool"), null, (_, _) => actions.InstallCommandLineTool());
        if (updateReady) menu.Items.Add(Strings.L("Restart to Update"), null, (_, _) => actions.RestartToUpdate());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Strings.L("Quit Cohub"), null, (_, _) => actions.Quit());

        var previous = icon.ContextMenuStrip;
        icon.ContextMenuStrip = menu;
        previous?.Dispose();

        var summary = overview.Summary;
        var next = summary is { } state ? Badge(state) : null;
        icon.Icon = next ?? plain;
        badged?.Dispose();
        badged = next;
        var text = sharing ? $"Cohub · {Strings.L("Sharing this screen")}" : summary is { } current ? $"Cohub · {Describe(current)}" : "Cohub";
        icon.Text = text.Length > 63 ? text[..63] : text;
    }

    private static string Describe(RuntimeOverview.State state) => state switch
    {
        RuntimeOverview.State.Ready => Strings.L("Connected"),
        RuntimeOverview.State.Connecting => Strings.L("Connecting…"),
        RuntimeOverview.State.Error => Strings.L("Needs attention"),
        _ => Strings.L("Not connected"),
    };

    private static Color ColorOf(RuntimeOverview.State state) => state switch
    {
        RuntimeOverview.State.Ready => Color.FromArgb(0x16, 0xA3, 0x4A),
        RuntimeOverview.State.Connecting => Color.FromArgb(0xEA, 0xB3, 0x08),
        RuntimeOverview.State.Error => Color.FromArgb(0xDC, 0x26, 0x26),
        _ => SystemColors.GrayText,
    };

    private static Bitmap Dot(RuntimeOverview.State state, int size)
    {
        var bitmap = new Bitmap(size, size);
        using var graphics = Graphics.FromImage(bitmap);
        graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        using var brush = new SolidBrush(ColorOf(state));
        graphics.FillEllipse(brush, 2, 2, size - 4, size - 4);
        return bitmap;
    }

    private Icon Badge(RuntimeOverview.State state)
    {
        using var bitmap = plain.ToBitmap();
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            var size = bitmap.Width * 0.5f;
            var bounds = new RectangleF(bitmap.Width - size, bitmap.Height - size, size, size);
            using var ring = new SolidBrush(Color.White);
            using var fill = new SolidBrush(ColorOf(state));
            graphics.FillEllipse(ring, bounds);
            bounds.Inflate(-size * 0.18f, -size * 0.18f);
            graphics.FillEllipse(fill, bounds);
        }
        var handle = bitmap.GetHicon();
        try { return (Icon)Icon.FromHandle(handle).Clone(); }
        finally { Native.DestroyIcon(handle); }
    }

    public void Dispose()
    {
        icon.Visible = false;
        icon.ContextMenuStrip?.Dispose();
        icon.Dispose();
        badged?.Dispose();
    }
}
