using System.Data;
using System.Data.SQLite;
using Dapper;
using WikiProto.Models;

namespace WikiProto.Services
{
    public class NoticesService
    {
        private readonly string _cs;

        public NoticesService(IConfiguration cfg)
        {
            _cs = cfg.GetConnectionString("Default") ?? "Data Source=Data/wiki.db";
        }

        private IDbConnection CreateConn()
        {
            var conn = new SQLiteConnection(_cs);
            conn.Open();
            conn.Execute("PRAGMA foreign_keys = ON;");
            conn.Execute("PRAGMA busy_timeout = 5000;");
            return conn;
        }

        public void Initialize()
        {
            using var db = CreateConn();
            db.Execute("PRAGMA foreign_keys = ON;");
            db.Execute(@"CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    body TEXT,
    created_at DATETIME
);");
        }

        public IEnumerable<Notice> GetLatest(int limit = 5)
        {
            using var db = CreateConn();
            return db.Query<Notice>("SELECT id, title, body, created_at AS CreatedAt FROM notices ORDER BY created_at DESC LIMIT @Limit", new { Limit = limit });
        }

        public IEnumerable<Notice> GetAll()
        {
            using var db = CreateConn();
            return db.Query<Notice>("SELECT id, title, body, created_at AS CreatedAt FROM notices ORDER BY created_at DESC");
        }

        public Notice Create(string title, string body)
        {
            using var db = CreateConn();
            var now = DateTime.UtcNow;
            db.Execute("INSERT INTO notices (title, body, created_at) VALUES (@Title, @Body, @Created)", new { Title = title, Body = body, Created = now });
            var id = db.ExecuteScalar<long>("SELECT last_insert_rowid();");
            return db.QueryFirst<Notice>("SELECT id, title, body, created_at AS CreatedAt FROM notices WHERE id = @Id", new { Id = id });
        }

        public Notice Update(long id, string title, string body, DateTime createdAt)
        {
            using var db = CreateConn();
            db.Execute("UPDATE notices SET title = @Title, body = @Body, created_at = @Created WHERE id = @Id", new { Title = title, Body = body, Created = createdAt, Id = id });
            var notice = db.QueryFirstOrDefault<Notice>("SELECT id, title, body, created_at AS CreatedAt FROM notices WHERE id = @Id", new { Id = id });
            if (notice is null)
            {
                throw new InvalidOperationException($"Notice with id {id} not found after update.");
            }
            return notice;
        }

        public void Delete(long id)
        {
            using var db = CreateConn();
            db.Execute("DELETE FROM notices WHERE id = @Id", new { Id = id });
        }
    }
}
