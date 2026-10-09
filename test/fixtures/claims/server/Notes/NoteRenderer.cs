namespace Notebook.Server.Notes;

/// <summary>Renders note blocks as HTML for the web client.</summary>
public sealed class NoteRenderer
{
    public string Render(Note note)
    {
        var html = new System.Text.StringBuilder();
        foreach (var block in note.Blocks)
        {
            html.Append(block switch
            {
                HeadingBlock h => RenderHeading(h),
                ListBlock l => RenderList(l),
                ImageBlock i => RenderImage(i),
                _ => RenderParagraph((TextBlock)block),
            });
        }
        return html.ToString();
    }

    private static string RenderHeading(HeadingBlock h) => $"<h{h.Level}>{h.Text}</h{h.Level}>";
    private static string RenderList(ListBlock l) => $"<ul>{string.Concat(l.Items.Select(i => $"<li>{i}</li>"))}</ul>";
    private static string RenderImage(ImageBlock i) => $"<img src=\"{i.Url}\" alt=\"{i.Alt}\">";
    private static string RenderParagraph(TextBlock t) => $"<p>{t.Text}</p>";
}
