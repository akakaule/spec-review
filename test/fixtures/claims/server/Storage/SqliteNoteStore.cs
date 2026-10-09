namespace Notebook.Server.Storage;

/// <summary>SQLite implementation of the note store.</summary>
public sealed class SqliteNoteStore(SqliteConnection connection) : INoteStore
{
    private const int PageSize = 100;

    /// <summary>Lists one page of a notebook's notes; callers loop until the token is null.</summary>
    public async Task<NotePage> ListNotes(string notebookId, string? continuationToken)
    {
        var offset = continuationToken is null ? 0 : int.Parse(continuationToken);
        var notes = await connection.QueryAsync<Note>(
            "SELECT * FROM notes WHERE notebook_id = @notebookId ORDER BY id LIMIT @take OFFSET @offset",
            new { notebookId, take = PageSize, offset });
        var next = notes.Count == PageSize ? (offset + PageSize).ToString() : null;
        return new NotePage(notes, next);
    }
}
