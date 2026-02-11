import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies before importing the handler
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock('../config.js', () => ({
  execFilePromise: vi.fn(async () => ({ stdout: '[]', stderr: '' })),
}));

vi.mock('../security.js', () => ({
  assertPathSafe: vi.fn((path: string) => path),
}));

import { handler } from '../tools/database.js';
import { execFilePromise } from '../config.js';

const query = (sql: string) =>
  handler('sqlite_query', { db_path: 'test.db', query: sql });

describe('database – SQL injection protections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Allowed SQL keywords ──

  describe('allowed keywords', () => {
    it('should allow SELECT queries', async () => {
      const result = await query('SELECT * FROM users');
      expect(result.content[0].text).toBe('[]');
      expect(execFilePromise).toHaveBeenCalledWith(
        'sqlite3', ['-json', 'test.db', 'SELECT * FROM users']
      );
    });

    it('should allow PRAGMA queries', async () => {
      await query('PRAGMA table_info(users)');
      expect(execFilePromise).toHaveBeenCalled();
    });

    it('should allow EXPLAIN queries', async () => {
      await query('EXPLAIN SELECT 1');
      expect(execFilePromise).toHaveBeenCalled();
    });

    it('should allow select (lowercase) as first keyword', async () => {
      await query('select 1');
      expect(execFilePromise).toHaveBeenCalled();
    });
  });

  // ── First-keyword whitelist rejects non-SELECT/PRAGMA/EXPLAIN ──

  describe('first-keyword whitelist', () => {
    it('should reject INSERT as first keyword', async () => {
      await expect(query('INSERT INTO users VALUES(1)'))
        .rejects.toThrow(/Only SELECT, PRAGMA, and EXPLAIN/);
      expect(execFilePromise).not.toHaveBeenCalled();
    });

    it('should reject DELETE as first keyword', async () => {
      await expect(query('DELETE FROM users'))
        .rejects.toThrow(/Only SELECT, PRAGMA, and EXPLAIN/);
    });

    it('should reject UPDATE as first keyword', async () => {
      await expect(query('UPDATE users SET name="x"'))
        .rejects.toThrow(/Only SELECT, PRAGMA, and EXPLAIN/);
    });

    it('should reject DROP as first keyword', async () => {
      await expect(query('DROP TABLE users'))
        .rejects.toThrow(/Only SELECT, PRAGMA, and EXPLAIN/);
    });

    it('should reject CREATE as first keyword', async () => {
      await expect(query('CREATE TABLE x(id int)'))
        .rejects.toThrow(/Only SELECT, PRAGMA, and EXPLAIN/);
    });
  });

  // ── Semicolon injection blocking ──

  describe('semicolon injection', () => {
    it('should block multiple statements separated by semicolons', async () => {
      await expect(query('SELECT 1; DROP TABLE x'))
        .rejects.toThrow(/Multiple SQL statements are not allowed/);
      expect(execFilePromise).not.toHaveBeenCalled();
    });

    it('should block trailing semicolons with additional statements', async () => {
      await expect(query('SELECT * FROM users; DELETE FROM users'))
        .rejects.toThrow(/Multiple SQL statements are not allowed/);
    });

    it('should allow semicolons inside single-quoted string literals', async () => {
      await query("SELECT 'foo;bar' FROM t");
      expect(execFilePromise).toHaveBeenCalled();
    });

    it('should allow semicolons inside double-quoted string literals', async () => {
      await query('SELECT "foo;bar" FROM t');
      expect(execFilePromise).toHaveBeenCalled();
    });

    it('should allow semicolons in multiple string literals', async () => {
      await query("SELECT 'a;b', 'c;d' FROM t");
      expect(execFilePromise).toHaveBeenCalled();
    });
  });

  // ── Dangerous keyword blocklist (inside valid SELECT) ──

  describe('dangerous keyword blocklist', () => {
    const dangerousKeywords = [
      'DELETE', 'DROP', 'INSERT', 'UPDATE', 'CREATE', 'ALTER', 'ATTACH', 'DETACH',
    ];

    for (const keyword of dangerousKeywords) {
      it(`should block ${keyword} embedded in a SELECT subquery`, async () => {
        await expect(query(`SELECT * FROM (${keyword} FROM t)`))
          .rejects.toThrow(new RegExp(`${keyword} statements are not allowed`));
        expect(execFilePromise).not.toHaveBeenCalled();
      });
    }

    it('should be case-insensitive for dangerous keywords', async () => {
      await expect(query('SELECT * FROM (delete FROM users)'))
        .rejects.toThrow(/DELETE statements are not allowed/);

      await expect(query('SELECT * FROM (Drop table x)'))
        .rejects.toThrow(/DROP statements are not allowed/);

      await expect(query('SELECT * FROM (aTTACH db AS o)'))
        .rejects.toThrow(/ATTACH statements are not allowed/);
    });

    it('should not false-positive on substrings (SELECTED, CREATION)', async () => {
      // "SELECTED" contains "SELECT" but not "DELETE" as a word boundary
      await query('SELECT SELECTED FROM t');
      expect(execFilePromise).toHaveBeenCalled();
    });
  });

  // ── Unknown tool ──

  describe('unknown tool', () => {
    it('should throw for unrecognized tool name', async () => {
      await expect(handler('unknown_tool', { db_path: 'a.db', query: 'SELECT 1' }))
        .rejects.toThrow(/Unknown tool/);
    });
  });
});
