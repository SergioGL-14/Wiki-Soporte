using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SQLite;
using Dapper;
using Microsoft.Extensions.Configuration;
using WikiProto.Models;

namespace WikiProto.Services
{
    public record BoardDto(long Id, string Name, DateTime CreatedAt, DateTime UpdatedAt);
    public record CardDto(long Id, long BoardId, string Title, string Description, DateTime CreatedAt, DateTime UpdatedAt);

    public class IncidentsService
    {
        private readonly string _cs;
        public IncidentsService(IConfiguration config) => _cs = config.GetConnectionString("Default") ?? "Data Source=Data/wiki.db";
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
            db.Execute(@"CREATE TABLE IF NOT EXISTS boards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE,
                created_at DATETIME,
                updated_at DATETIME
            );");
            db.Execute(@"CREATE TABLE IF NOT EXISTS cards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                board_id INTEGER,
                title TEXT,
                description TEXT,
                created_at DATETIME,
                updated_at DATETIME,
                resolved INTEGER DEFAULT 0,
                resolved_at DATETIME NULL,
                FOREIGN KEY(board_id) REFERENCES boards(id) ON DELETE CASCADE
            );");
            // Add columns to existing table if missing (safe tries)
            try { db.Execute("ALTER TABLE cards ADD COLUMN resolved INTEGER DEFAULT 0;"); } catch { }
            try { db.Execute("ALTER TABLE cards ADD COLUMN resolved_at DATETIME NULL;"); } catch { }
        }

        public IEnumerable<BoardDto> GetBoards()
        {
            using var db = CreateConn();
            return db.Query<BoardDto>("SELECT id AS Id, name AS Name, created_at AS CreatedAt, updated_at AS UpdatedAt FROM boards ORDER BY id;");
        }

        public BoardDto CreateBoard(string name)
        {
            using var db = CreateConn();
            var now = DateTime.UtcNow;
            db.Execute("INSERT INTO boards (name, created_at, updated_at) VALUES (@Name, @Now, @Now);", new { Name = name, Now = now });
            var id = db.ExecuteScalar<long>("SELECT last_insert_rowid();");
            return new BoardDto(id, name, now, now);
        }

        public void DeleteBoard(long id)
        {
            using var db = CreateConn();
            db.Execute("DELETE FROM boards WHERE id = @Id;", new { Id = id });
        }

        public IEnumerable<CardDto> GetCards(long? boardId = null)
        {
            using var db = CreateConn();
            // By default return only unresolved cards. Use SQL flags in endpoints to include resolved.
            if (boardId.HasValue)
            {
                return db.Query<CardDto>("SELECT id AS Id, board_id AS BoardId, title AS Title, description AS Description, created_at AS CreatedAt, updated_at AS UpdatedAt FROM cards WHERE board_id = @B AND (resolved IS NULL OR resolved = 0) ORDER BY created_at;", new { B = boardId.Value });
            }
            return db.Query<CardDto>("SELECT id AS Id, board_id AS BoardId, title AS Title, description AS Description, created_at AS CreatedAt, updated_at AS UpdatedAt FROM cards WHERE (resolved IS NULL OR resolved = 0) ORDER BY created_at;");
        }

        public IEnumerable<CardDto> GetResolvedCards(long? boardId = null)
        {
            using var db = CreateConn();
            if (boardId.HasValue)
            {
                return db.Query<CardDto>("SELECT id AS Id, board_id AS BoardId, title AS Title, description AS Description, created_at AS CreatedAt, updated_at AS UpdatedAt FROM cards WHERE board_id = @B AND resolved = 1 ORDER BY resolved_at DESC;", new { B = boardId.Value });
            }
            return db.Query<CardDto>("SELECT id AS Id, board_id AS BoardId, title AS Title, description AS Description, created_at AS CreatedAt, updated_at AS UpdatedAt FROM cards WHERE resolved = 1 ORDER BY resolved_at DESC;");
        }

        public void ResolveCard(long id)
        {
            using var db = CreateConn();
            db.Execute("UPDATE cards SET resolved = 1, resolved_at = @Now WHERE id = @Id;", new { Now = DateTime.UtcNow, Id = id });
        }

        public void UnresolveCard(long id)
        {
            using var db = CreateConn();
            db.Execute("UPDATE cards SET resolved = 0, resolved_at = NULL WHERE id = @Id;", new { Id = id });
        }

        public CardDto CreateCard(long boardId, string title, string description)
        {
            using var db = CreateConn();
            var now = DateTime.UtcNow;
            db.Execute("INSERT INTO cards (board_id, title, description, created_at, updated_at) VALUES (@Board, @Title, @Desc, @Now, @Now);", new { Board = boardId, Title = title, Desc = description, Now = now });
            var id = db.ExecuteScalar<long>("SELECT last_insert_rowid();");
            return new CardDto(id, boardId, title, description, now, now);
        }

        public void MoveCard(long cardId, long newBoardId)
        {
            using var db = CreateConn();
            db.Execute("UPDATE cards SET board_id = @Board, updated_at = @Now WHERE id = @Id;", new { Board = newBoardId, Now = DateTime.UtcNow, Id = cardId });
        }

        public void DeleteCard(long id)
        {
            using var db = CreateConn();
            db.Execute("DELETE FROM cards WHERE id = @Id;", new { Id = id });
        }
    }
}
