using System.Data.SQLite;
using Dapper;
using WikiProto.Models;

namespace WikiProto.Services
{
    public class CategoriesService
    {
        private readonly string _cs;

        public CategoriesService(IConfiguration cfg)
        {
            _cs = cfg.GetConnectionString("Default") ?? "Data Source=Data/wiki.db";
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

        private static string NormalizeName(string name)
        {
            var normalized = (name ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(normalized))
            {
                throw new InvalidOperationException("Category name is required.");
            }

            return normalized;
        }

        private static IReadOnlyList<long> GetDescendantIds(SQLiteConnection db, long rootId, SQLiteTransaction tx)
        {
            var result = new List<long>();
            var queue = new Queue<(long Id, int Depth)>();
            var seen = new HashSet<long>();
            var ordered = new List<(long Id, int Depth)>();

            queue.Enqueue((rootId, 0));
            seen.Add(rootId);

            while (queue.Count > 0)
            {
                var current = queue.Dequeue();
                ordered.Add(current);

                var children = db.Query<long>(
                    "SELECT id FROM categories WHERE parent_id = @ParentId",
                    new { ParentId = current.Id },
                    tx);

                foreach (var childId in children)
                {
                    if (seen.Add(childId))
                    {
                        queue.Enqueue((childId, current.Depth + 1));
                    }
                }
            }

            foreach (var item in ordered.OrderByDescending(x => x.Depth))
            {
                result.Add(item.Id);
            }

            return result;
        }

        private static IReadOnlyList<long> GetAffectedPageIds(SQLiteConnection db, IEnumerable<long> categoryIds, SQLiteTransaction tx)
        {
            var ids = categoryIds.Distinct().ToArray();
            if (ids.Length == 0) return Array.Empty<long>();

            return db.Query<long>(
                "SELECT DISTINCT page_id FROM page_categories WHERE category_id IN @Ids",
                new { Ids = ids },
                tx).ToArray();
        }

        private static void RefreshPageCategoryCsv(SQLiteConnection db, IEnumerable<long> pageIds, SQLiteTransaction tx)
        {
            var ids = pageIds.Distinct().ToArray();
            if (ids.Length == 0) return;

            var rows = db.Query<(long Id, string Categories)>(
                @"SELECT p.id AS Id,
                         COALESCE(
                             (
                                 SELECT GROUP_CONCAT(name, ', ')
                                 FROM (
                                     SELECT c.name AS name
                                     FROM page_categories pc
                                     JOIN categories c ON c.id = pc.category_id
                                     WHERE pc.page_id = p.id
                                     ORDER BY c.name
                                 )
                             ),
                             ''
                         ) AS Categories
                  FROM pages p
                  WHERE p.id IN @Ids",
                new { Ids = ids },
                tx);

            foreach (var row in rows)
            {
                db.Execute(
                    "UPDATE pages SET categories = @Categories WHERE id = @Id",
                    new { row.Categories, row.Id },
                    tx);
            }
        }

        public IEnumerable<Category> GetAll()
        {
            using var db = CreateConn();
            return db.Query<Category>(
                "SELECT id, name, parent_id AS ParentId, created_at AS CreatedAt, updated_at AS UpdatedAt FROM categories ORDER BY name");
        }

        public IEnumerable<Category> GetRoots()
        {
            using var db = CreateConn();
            return db.Query<Category>(
                "SELECT id, name, parent_id AS ParentId, created_at AS CreatedAt, updated_at AS UpdatedAt FROM categories WHERE parent_id IS NULL ORDER BY name");
        }

        public IEnumerable<Category> GetChildren(long parentId)
        {
            using var db = CreateConn();
            return db.Query<Category>(
                "SELECT id, name, parent_id AS ParentId, created_at AS CreatedAt, updated_at AS UpdatedAt FROM categories WHERE parent_id = @Pid ORDER BY name",
                new { Pid = parentId });
        }

        public Category? GetById(long id)
        {
            using var db = CreateConn();
            return db.QueryFirstOrDefault<Category>(
                "SELECT id, name, parent_id AS ParentId, created_at AS CreatedAt, updated_at AS UpdatedAt FROM categories WHERE id = @Id",
                new { Id = id });
        }

        public Category Create(string name, long? parentId = null)
        {
            using var db = CreateConn();
            using var tx = db.BeginTransaction();

            name = NormalizeName(name);

            if (parentId.HasValue)
            {
                var parentExists = db.ExecuteScalar<long?>(
                    "SELECT id FROM categories WHERE id = @Id",
                    new { Id = parentId.Value },
                    tx);

                if (!parentExists.HasValue)
                {
                    throw new InvalidOperationException("Parent category does not exist.");
                }
            }

            var now = DateTime.UtcNow;
            db.Execute(
                "INSERT INTO categories (name, parent_id, created_at, updated_at) VALUES (@Name, @Parent, @Created, @Updated)",
                new { Name = name, Parent = parentId, Created = now, Updated = now },
                tx);

            var id = db.ExecuteScalar<long>("SELECT last_insert_rowid();", transaction: tx);
            tx.Commit();
            return GetById(id)!;
        }

        public void Update(long id, string name, long? parentId)
        {
            using var db = CreateConn();
            using var tx = db.BeginTransaction();

            var current = db.QueryFirstOrDefault<Category>(
                "SELECT id, name, parent_id AS ParentId, created_at AS CreatedAt, updated_at AS UpdatedAt FROM categories WHERE id = @Id",
                new { Id = id },
                tx);

            if (current == null)
            {
                throw new InvalidOperationException("Category not found.");
            }

            name = NormalizeName(name);

            if (parentId == id)
            {
                throw new InvalidOperationException("A category cannot be its own parent.");
            }

            if (parentId.HasValue)
            {
                var parentExists = db.ExecuteScalar<long?>(
                    "SELECT id FROM categories WHERE id = @Id",
                    new { Id = parentId.Value },
                    tx);

                if (!parentExists.HasValue)
                {
                    throw new InvalidOperationException("Parent category does not exist.");
                }

                var descendants = GetDescendantIds(db, id, tx);
                if (descendants.Contains(parentId.Value))
                {
                    throw new InvalidOperationException("Cannot assign a descendant as parent.");
                }
            }

            db.Execute(
                "UPDATE categories SET name = @Name, parent_id = @Parent, updated_at = @Updated WHERE id = @Id",
                new { Name = name, Parent = parentId, Updated = DateTime.UtcNow, Id = id },
                tx);

            var affectedPageIds = GetAffectedPageIds(db, new[] { id }, tx);
            RefreshPageCategoryCsv(db, affectedPageIds, tx);

            tx.Commit();
        }

        public void Delete(long id)
        {
            using var db = CreateConn();
            using var tx = db.BeginTransaction();

            var existing = db.ExecuteScalar<long?>("SELECT id FROM categories WHERE id = @Id", new { Id = id }, tx);
            if (!existing.HasValue)
            {
                tx.Commit();
                return;
            }

            var categoryIds = GetDescendantIds(db, id, tx);
            var affectedPageIds = GetAffectedPageIds(db, categoryIds, tx);

            db.Execute("DELETE FROM page_categories WHERE category_id IN @Ids", new { Ids = categoryIds.ToArray() }, tx);

            foreach (var categoryId in categoryIds)
            {
                db.Execute("DELETE FROM categories WHERE id = @Id", new { Id = categoryId }, tx);
            }

            RefreshPageCategoryCsv(db, affectedPageIds, tx);
            tx.Commit();
        }

        public Category GetOrCreateByName(string name)
        {
            using var db = CreateConn();
            name = NormalizeName(name);

            var category = db.QueryFirstOrDefault<Category>(
                "SELECT id, name, parent_id AS ParentId, created_at AS CreatedAt, updated_at AS UpdatedAt FROM categories WHERE name = @Name",
                new { Name = name });

            if (category != null) return category;
            return Create(name);
        }
    }
}
