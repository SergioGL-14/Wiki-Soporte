using System.Data.SQLite;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using Dapper;
using WikiProto.Models;

namespace WikiProto.Services
{
    public class PageService
    {
        private readonly string _cs;
        private bool _ftsAvailable;

        public PageService(IConfiguration config)
        {
            _cs = config.GetConnectionString("Default") ?? "Data Source=Data/wiki.db";
        }

        private SQLiteConnection CreateConn()
        {
            var conn = new SQLiteConnection(_cs);
            conn.Open();
            conn.Execute("PRAGMA foreign_keys = ON;");
            conn.Execute("PRAGMA busy_timeout = 5000;");
            conn.Execute("PRAGMA journal_mode = WAL;");
            return conn;
        }

        private static string BuildExcerpt(string? html, int maxLength = 220)
        {
            if (string.IsNullOrWhiteSpace(html)) return string.Empty;

            var text = Regex.Replace(html, "<(script|style)[^>]*>.*?</\\1>", " ", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            text = Regex.Replace(text, "<[^>]+>", " ");
            text = WebUtility.HtmlDecode(text);
            text = Regex.Replace(text, "\\s+", " ").Trim();

            if (text.Length <= maxLength) return text;

            var cut = text.LastIndexOf(' ', maxLength);
            if (cut < maxLength / 2) cut = maxLength;
            return text[..cut].Trim() + "...";
        }

        private static string[] ParseCategoryNames(string? csv)
        {
            return (csv ?? string.Empty)
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(name => name.Trim())
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        private static string JoinCategoryNames(IEnumerable<string> names)
        {
            return string.Join(", ", names
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Select(name => name.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(name => name, StringComparer.OrdinalIgnoreCase));
        }

        private static string Slugify(string? rawValue)
        {
            if (string.IsNullOrWhiteSpace(rawValue)) return string.Empty;

            var normalized = rawValue.Trim().ToLowerInvariant().Normalize(NormalizationForm.FormD);
            var sb = new StringBuilder();

            foreach (var ch in normalized)
            {
                var category = CharUnicodeInfo.GetUnicodeCategory(ch);
                if (category == UnicodeCategory.NonSpacingMark) continue;
                sb.Append(ch);
            }

            var ascii = sb.ToString().Normalize(NormalizationForm.FormC);
            ascii = Regex.Replace(ascii, @"[^a-z0-9]+", "-");
            ascii = Regex.Replace(ascii, @"-+", "-").Trim('-');
            return ascii;
        }

        private static string? BuildSafeFtsQuery(string? q)
        {
            if (string.IsNullOrWhiteSpace(q)) return null;

            var trimmed = Regex.Replace(q.Trim(), "\\s+", " ");
            if (!Regex.IsMatch(trimmed, @"^[\p{L}\p{N}\s]+$")) return null;

            var tokens = trimmed
                .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(token => token.Length > 0)
                .Take(8)
                .Select(token => $"{token}*")
                .ToArray();

            return tokens.Length == 0 ? null : string.Join(" AND ", tokens);
        }

        private static string PageSummaryProjection(string alias = "p") => $@"
{alias}.id,
{alias}.slug,
{alias}.title,
{alias}.excerpt,
COALESCE(
    (
        SELECT GROUP_CONCAT(name, ', ')
        FROM (
            SELECT c.name AS name
            FROM page_categories pc
            JOIN categories c ON c.id = pc.category_id
            WHERE pc.page_id = {alias}.id
            ORDER BY c.name
        )
    ),
    ''
) AS Categories,
{alias}.created_at AS CreatedAt,
{alias}.updated_at AS UpdatedAt";

        private static string PageDetailProjection(string alias = "p") => $@"
{alias}.id,
{alias}.slug,
{alias}.title,
{alias}.html_content AS HtmlContent,
{alias}.excerpt,
COALESCE(
    (
        SELECT GROUP_CONCAT(name, ', ')
        FROM (
            SELECT c.name AS name
            FROM page_categories pc
            JOIN categories c ON c.id = pc.category_id
            WHERE pc.page_id = {alias}.id
            ORDER BY c.name
        )
    ),
    ''
) AS Categories,
{alias}.created_at AS CreatedAt,
{alias}.updated_at AS UpdatedAt";

        private static long EnsureCategoryExists(SQLiteConnection db, string name, DateTime now, SQLiteTransaction tx)
        {
            var categoryId = db.ExecuteScalar<long?>(
                "SELECT id FROM categories WHERE name = @Name",
                new { Name = name },
                tx);

            if (categoryId.HasValue) return categoryId.Value;

            db.Execute(
                "INSERT INTO categories (name, created_at, updated_at) VALUES (@Name, @Now, @Now)",
                new { Name = name, Now = now },
                tx);

            return db.ExecuteScalar<long>("SELECT last_insert_rowid();", transaction: tx);
        }

        private void SyncPageCategories(SQLiteConnection db, Page page, DateTime now, SQLiteTransaction tx)
        {
            var categoryNames = ParseCategoryNames(page.Categories);
            page.Categories = JoinCategoryNames(categoryNames);

            db.Execute("DELETE FROM page_categories WHERE page_id = @PageId", new { PageId = page.Id }, tx);

            foreach (var name in categoryNames)
            {
                var categoryId = EnsureCategoryExists(db, name, now, tx);
                db.Execute(
                    "INSERT OR IGNORE INTO page_categories (page_id, category_id) VALUES (@PageId, @CategoryId)",
                    new { PageId = page.Id, CategoryId = categoryId },
                    tx);
            }

            db.Execute(
                "UPDATE pages SET categories = @Categories WHERE id = @Id",
                new { page.Categories, page.Id },
                tx);
        }

        private void BackfillExcerpts(SQLiteConnection db)
        {
            var rows = db.Query<(long Id, string HtmlContent)>(
                "SELECT id AS Id, html_content AS HtmlContent FROM pages WHERE excerpt IS NULL OR trim(excerpt) = ''");

            foreach (var row in rows)
            {
                var excerpt = BuildExcerpt(row.HtmlContent);
                db.Execute("UPDATE pages SET excerpt = @Excerpt WHERE id = @Id", new { Id = row.Id, Excerpt = excerpt });
            }
        }

        private void BackfillPageCategoryLinks(SQLiteConnection db)
        {
            var pages = db.Query<(long Id, string Categories)>(
                "SELECT id AS Id, COALESCE(categories, '') AS Categories FROM pages").ToList();

            using var tx = db.BeginTransaction();

            foreach (var page in pages)
            {
                var relationalNames = db.Query<string>(
                    @"SELECT c.name
                      FROM page_categories pc
                      JOIN categories c ON c.id = pc.category_id
                      WHERE pc.page_id = @PageId
                      ORDER BY c.name",
                    new { PageId = page.Id },
                    tx).ToList();

                var namesToUse = relationalNames.Count > 0
                    ? relationalNames
                    : ParseCategoryNames(page.Categories).ToList();

                if (relationalNames.Count == 0 && namesToUse.Count > 0)
                {
                    foreach (var name in namesToUse)
                    {
                        var categoryId = EnsureCategoryExists(db, name, DateTime.UtcNow, tx);
                        db.Execute(
                            "INSERT OR IGNORE INTO page_categories (page_id, category_id) VALUES (@PageId, @CategoryId)",
                            new { PageId = page.Id, CategoryId = categoryId },
                            tx);
                    }
                }

                var normalizedCsv = JoinCategoryNames(namesToUse);
                db.Execute(
                    "UPDATE pages SET categories = @Categories WHERE id = @Id",
                    new { Id = page.Id, Categories = normalizedCsv },
                    tx);
            }

            tx.Commit();
        }

        public void Initialize()
        {
            using var db = CreateConn();
            db.Execute("PRAGMA synchronous = NORMAL;");
            db.Execute("PRAGMA temp_store = MEMORY;");

            db.Execute(@"CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE,
    title TEXT,
    html_content TEXT,
    excerpt TEXT,
    categories TEXT DEFAULT '',
    created_at DATETIME,
    updated_at DATETIME
);

CREATE TABLE IF NOT EXISTS revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER,
    html_content TEXT,
    author TEXT,
    created_at DATETIME,
    FOREIGN KEY(page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    parent_id INTEGER NULL,
    created_at DATETIME,
    updated_at DATETIME,
    FOREIGN KEY(parent_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS page_categories (
    page_id INTEGER,
    category_id INTEGER,
    PRIMARY KEY (page_id, category_id),
    FOREIGN KEY(page_id) REFERENCES pages(id) ON DELETE CASCADE,
    FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE CASCADE
);");

            try
            {
                db.Execute("CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(title, html_content, content='pages', content_rowid='id');");
                _ftsAvailable = true;

                var count = db.ExecuteScalar<int>("SELECT COUNT(*) FROM pages");
                if (count > 0)
                {
                    db.Execute("INSERT INTO page_fts(rowid, title, html_content) SELECT id, title, html_content FROM pages WHERE id NOT IN (SELECT rowid FROM page_fts);");
                }
            }
            catch (SQLiteException)
            {
                _ftsAvailable = false;
            }

            try
            {
                db.Execute("ALTER TABLE pages ADD COLUMN categories TEXT DEFAULT '';");
            }
            catch
            {
                // Column already exists.
            }

            db.Execute(@"CREATE INDEX IF NOT EXISTS idx_pages_updated_at ON pages(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pages_created_at ON pages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_page_categories_page_id ON page_categories(page_id);
CREATE INDEX IF NOT EXISTS idx_page_categories_category_id ON page_categories(category_id);");

            BackfillExcerpts(db);
            BackfillPageCategoryLinks(db);
        }

        public IEnumerable<Page> GetLatest(int limit = 10)
        {
            using var db = CreateConn();
            return db.Query<Page>(
                $"SELECT {PageSummaryProjection("p")} FROM pages p ORDER BY p.updated_at DESC LIMIT @Limit",
                new { Limit = limit });
        }

        public IEnumerable<Page> GetAll()
        {
            using var db = CreateConn();
            return db.Query<Page>(
                $"SELECT {PageSummaryProjection("p")} FROM pages p ORDER BY p.updated_at DESC");
        }

        public IEnumerable<Page> GetByCategory(long categoryId)
        {
            using var db = CreateConn();
            return db.Query<Page>(
                $@"SELECT DISTINCT {PageSummaryProjection("p")}
                   FROM pages p
                   JOIN page_categories pc ON pc.page_id = p.id
                   WHERE pc.category_id = @CategoryId
                   ORDER BY p.updated_at DESC",
                new { CategoryId = categoryId });
        }

        public Page? GetById(long id)
        {
            using var db = CreateConn();
            return db.QueryFirstOrDefault<Page>(
                $"SELECT {PageDetailProjection("p")} FROM pages p WHERE p.id = @Id",
                new { Id = id });
        }

        public Page? GetBySlug(string slug)
        {
            using var db = CreateConn();
            return db.QueryFirstOrDefault<Page>(
                $"SELECT {PageDetailProjection("p")} FROM pages p WHERE p.slug = @Slug",
                new { Slug = slug });
        }

        public Page CreateOrUpdate(Page page, string author = "")
        {
            using var db = CreateConn();
            using var tx = db.BeginTransaction();

            var now = DateTime.UtcNow;
            page.Title = (page.Title ?? string.Empty).Trim();
            page.Slug = Slugify(string.IsNullOrWhiteSpace(page.Slug) ? page.Title : page.Slug);

            if (string.IsNullOrWhiteSpace(page.Title))
            {
                throw new InvalidOperationException("Title is required.");
            }

            if (string.IsNullOrWhiteSpace(page.Slug))
            {
                throw new InvalidOperationException("Slug could not be generated.");
            }

            page.UpdatedAt = now;
            page.Excerpt = BuildExcerpt(page.HtmlContent);

            var existingById = page.Id > 0
                ? db.QueryFirstOrDefault<Page>(
                    "SELECT id, slug, title, html_content AS HtmlContent, excerpt, categories, created_at AS CreatedAt, updated_at AS UpdatedAt FROM pages WHERE id = @Id",
                    new { page.Id },
                    tx)
                : null;

            var existingBySlug = db.QueryFirstOrDefault<Page>(
                "SELECT id, slug, title, html_content AS HtmlContent, excerpt, categories, created_at AS CreatedAt, updated_at AS UpdatedAt FROM pages WHERE slug = @Slug",
                new { page.Slug },
                tx);

            if (existingById != null)
            {
                if (existingBySlug != null && existingBySlug.Id != existingById.Id)
                {
                    throw new InvalidOperationException("Another page already uses the requested slug.");
                }

                page.Id = existingById.Id;
                page.CreatedAt = existingById.CreatedAt;

                db.Execute(
                    @"UPDATE pages
                      SET slug = @Slug,
                          title = @Title,
                          html_content = @HtmlContent,
                          excerpt = @Excerpt,
                          categories = @Categories,
                          updated_at = @UpdatedAt
                      WHERE id = @Id",
                    page,
                    tx);
            }
            else if (existingBySlug != null)
            {
                page.Id = existingBySlug.Id;
                page.CreatedAt = existingBySlug.CreatedAt;

                db.Execute(
                    @"UPDATE pages
                      SET title = @Title,
                          html_content = @HtmlContent,
                          excerpt = @Excerpt,
                          categories = @Categories,
                          updated_at = @UpdatedAt
                      WHERE id = @Id",
                    page,
                    tx);
            }
            else
            {
                page.CreatedAt = now;

                db.Execute(
                    @"INSERT INTO pages (slug, title, html_content, excerpt, categories, created_at, updated_at)
                      VALUES (@Slug, @Title, @HtmlContent, @Excerpt, @Categories, @CreatedAt, @UpdatedAt)",
                    page,
                    tx);

                page.Id = db.ExecuteScalar<long>("SELECT last_insert_rowid();", transaction: tx);
            }

            SyncPageCategories(db, page, now, tx);

            db.Execute(
                "INSERT INTO revisions (page_id, html_content, author, created_at) VALUES (@PageId, @HtmlContent, @Author, @CreatedAt)",
                new { PageId = page.Id, HtmlContent = page.HtmlContent, Author = author, CreatedAt = now },
                tx);

            if (_ftsAvailable)
            {
                try
                {
                    db.Execute("DELETE FROM page_fts WHERE rowid = @RowId", new { RowId = page.Id }, tx);
                    db.Execute(
                        "INSERT INTO page_fts(rowid, title, html_content) VALUES (@RowId, @Title, @HtmlContent)",
                        new { RowId = page.Id, page.Title, page.HtmlContent },
                        tx);
                }
                catch
                {
                    // If FTS maintenance fails, keep the transactional save and fall back to LIKE searches later.
                }
            }

            tx.Commit();
            return GetById(page.Id) ?? page;
        }

        public IEnumerable<Page> Search(string q, int limit = 50)
        {
            using var db = CreateConn();

            var safeFtsQuery = BuildSafeFtsQuery(q);
            if (_ftsAvailable && !string.IsNullOrWhiteSpace(safeFtsQuery))
            {
                try
                {
                    return db.Query<Page>(
                        $@"SELECT DISTINCT {PageSummaryProjection("p")}
                           FROM page_fts f
                           JOIN pages p ON p.id = f.rowid
                           WHERE page_fts MATCH @Q
                           ORDER BY p.updated_at DESC
                           LIMIT @Limit",
                        new { Q = safeFtsQuery, Limit = limit });
                }
                catch (SQLiteException)
                {
                    // Fall through to LIKE search.
                }
            }

            var like = "%" + (q ?? string.Empty).Trim() + "%";
            return db.Query<Page>(
                $@"SELECT {PageSummaryProjection("p")}
                   FROM pages p
                   WHERE p.title LIKE @Like
                      OR p.html_content LIKE @Like
                      OR p.categories LIKE @Like
                   ORDER BY CASE WHEN p.title LIKE @Like THEN 0 ELSE 1 END, p.updated_at DESC
                   LIMIT @Limit",
                new { Like = like, Limit = limit });
        }

        public Dictionary<string, int> GetCategories()
        {
            var map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var pages = GetAll();

            foreach (var page in pages)
            {
                foreach (var category in ParseCategoryNames(page.Categories))
                {
                    map[category] = map.TryGetValue(category, out var count) ? count + 1 : 1;
                }
            }

            return map;
        }

        public void Delete(long id)
        {
            using var db = CreateConn();
            using var tx = db.BeginTransaction();

            db.Execute("DELETE FROM page_categories WHERE page_id = @Id", new { Id = id }, tx);
            db.Execute("DELETE FROM revisions WHERE page_id = @Id", new { Id = id }, tx);

            if (_ftsAvailable)
            {
                try
                {
                    db.Execute("DELETE FROM page_fts WHERE rowid = @Id", new { Id = id }, tx);
                }
                catch
                {
                    // Ignore FTS cleanup issues.
                }
            }

            db.Execute("DELETE FROM pages WHERE id = @Id", new { Id = id }, tx);
            tx.Commit();
        }
    }
}
