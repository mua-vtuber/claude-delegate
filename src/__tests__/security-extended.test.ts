import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger to prevent file I/O
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock DNS lookup for assertUrlSafe tests
const mockLookup = vi.fn();
vi.mock('node:dns/promises', () => ({
  lookup: (...args: any[]) => mockLookup(...args),
}));

// Mock realpathSync for symlink tests while keeping other fs functions intact
const mockRealpathSync = vi.fn();
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return { ...orig, realpathSync: (...args: any[]) => mockRealpathSync(...args) };
});

import { isPathSafe, assertArgsAllowed, assertUrlSafe } from '../security.js';
import { PROJECT_ROOT } from '../config.js';
import { join } from 'path';

describe('security – extended', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ══════════════════════════════════════════════
  // isPathSafe – symlink protection
  // ══════════════════════════════════════════════

  describe('isPathSafe – symlink protection', () => {
    it('should reject a symlink whose real path is outside project root', () => {
      const symlinkPath = join(PROJECT_ROOT, 'innocent-looking-link');
      mockRealpathSync.mockReturnValue('C:\\Windows\\System32\\evil.dll');
      expect(isPathSafe(symlinkPath)).toBe(false);
    });

    it('should accept a symlink whose real path is inside project root', () => {
      const symlinkPath = join(PROJECT_ROOT, 'link-to-src');
      mockRealpathSync.mockReturnValue(join(PROJECT_ROOT, 'src', 'index.ts'));
      expect(isPathSafe(symlinkPath)).toBe(true);
    });

    it('should fall back to resolved path when file does not exist (ENOENT)', () => {
      mockRealpathSync.mockImplementation(() => { throw new Error('ENOENT'); });
      const newFile = join(PROJECT_ROOT, 'brand-new-file.ts');
      // Falls back to resolve() which stays inside PROJECT_ROOT
      expect(isPathSafe(newFile)).toBe(true);
    });

    it('should reject when resolved fallback is outside project root', () => {
      mockRealpathSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect(isPathSafe('C:\\Windows\\System32\\cmd.exe')).toBe(false);
    });
  });

  // ══════════════════════════════════════════════
  // assertArgsAllowed – dangerous argument blocking
  // ══════════════════════════════════════════════

  describe('assertArgsAllowed – blocked arguments', () => {
    // --- node ---
    it('should block node -e', () => {
      expect(() => assertArgsAllowed('node', ['-e', 'process.exit()']))
        .toThrow(/Security.*Argument.*"-e"/);
    });

    it('should block node --eval', () => {
      expect(() => assertArgsAllowed('node', ['--eval', 'code']))
        .toThrow(/Security.*Argument.*"--eval"/);
    });

    it('should block node --eval=inline', () => {
      expect(() => assertArgsAllowed('node', ['--eval=process.exit()']))
        .toThrow(/Security.*Argument/);
    });

    it('should block node --input-type', () => {
      expect(() => assertArgsAllowed('node', ['--input-type=module']))
        .toThrow(/Security.*Argument/);
    });

    it('should block node -p', () => {
      expect(() => assertArgsAllowed('node', ['-p', '"hello"']))
        .toThrow(/Security.*Argument.*"-p"/);
    });

    it('should block node --print', () => {
      expect(() => assertArgsAllowed('node', ['--print', '"hello"']))
        .toThrow(/Security.*Argument.*"--print"/);
    });

    // --- python ---
    it('should block python -c', () => {
      expect(() => assertArgsAllowed('python', ['-c', 'import os; os.system("rm -rf /")']))
        .toThrow(/Security.*Argument.*"-c"/);
    });

    it('should block python -m', () => {
      expect(() => assertArgsAllowed('python', ['-m', 'http.server']))
        .toThrow(/Security.*Argument.*"-m"/);
    });

    it('should block python3 -c', () => {
      expect(() => assertArgsAllowed('python3', ['-c', 'code']))
        .toThrow(/Security.*Argument.*"-c"/);
    });

    // --- npm ---
    it('should block npm exec', () => {
      expect(() => assertArgsAllowed('npm', ['exec', 'malicious-package']))
        .toThrow(/Security.*Argument.*"exec"/);
    });

    // --- .exe handling ---
    it('should strip .exe and still block dangerous args', () => {
      expect(() => assertArgsAllowed('node.exe', ['-e', 'code']))
        .toThrow(/Security/);
      expect(() => assertArgsAllowed('python.exe', ['-c', 'code']))
        .toThrow(/Security/);
    });

    // --- full path handling ---
    it('should handle full paths and still block dangerous args', () => {
      expect(() => assertArgsAllowed('/usr/bin/node', ['-e', 'code']))
        .toThrow(/Security/);
      expect(() => assertArgsAllowed('C:\\Program Files\\nodejs\\node.exe', ['-e', 'code']))
        .toThrow(/Security/);
    });
  });

  describe('assertArgsAllowed – safe arguments', () => {
    it('should allow node with a script file', () => {
      expect(() => assertArgsAllowed('node', ['server.js'])).not.toThrow();
    });

    it('should allow node with --inspect flag', () => {
      expect(() => assertArgsAllowed('node', ['--inspect', 'app.js'])).not.toThrow();
    });

    it('should allow python with a script file', () => {
      expect(() => assertArgsAllowed('python', ['script.py'])).not.toThrow();
    });

    it('should allow npm install', () => {
      expect(() => assertArgsAllowed('npm', ['install', 'lodash'])).not.toThrow();
    });

    it('should allow npm run build', () => {
      expect(() => assertArgsAllowed('npm', ['run', 'build'])).not.toThrow();
    });

    it('should allow npm test', () => {
      expect(() => assertArgsAllowed('npm', ['test'])).not.toThrow();
    });

    it('should skip checks for commands not in DANGEROUS_ARGS list', () => {
      expect(() => assertArgsAllowed('git', ['push', '--force'])).not.toThrow();
      expect(() => assertArgsAllowed('ls', ['-la'])).not.toThrow();
      expect(() => assertArgsAllowed('grep', ['-r', 'pattern'])).not.toThrow();
    });
  });

  // ══════════════════════════════════════════════
  // assertUrlSafe – SSRF protection
  // ══════════════════════════════════════════════

  describe('assertUrlSafe – URL format and protocol', () => {
    it('should reject malformed URLs', async () => {
      await expect(assertUrlSafe('not-a-url')).rejects.toThrow(/Invalid URL format/);
    });

    it('should reject ftp:// URLs', async () => {
      await expect(assertUrlSafe('ftp://example.com/file')).rejects.toThrow(/Only http\/https/);
    });

    it('should reject file:// URLs', async () => {
      await expect(assertUrlSafe('file:///etc/passwd')).rejects.toThrow(/Only http\/https/);
    });

    it('should reject javascript: URLs', async () => {
      await expect(assertUrlSafe('javascript:alert(1)')).rejects.toThrow(/Only http\/https/);
    });
  });

  describe('assertUrlSafe – private IP pattern matching', () => {
    it('should block localhost', async () => {
      await expect(assertUrlSafe('http://localhost:8080'))
        .rejects.toThrow(/private\/internal/);
    });

    it('should block 127.x.x.x', async () => {
      await expect(assertUrlSafe('http://127.0.0.1:3000'))
        .rejects.toThrow(/private\/internal/);
    });

    it('should block 10.x.x.x', async () => {
      await expect(assertUrlSafe('http://10.0.0.1'))
        .rejects.toThrow(/private\/internal/);
    });

    it('should block 192.168.x.x', async () => {
      await expect(assertUrlSafe('http://192.168.1.1'))
        .rejects.toThrow(/private\/internal/);
    });

    it('should block 172.16-31.x.x', async () => {
      await expect(assertUrlSafe('http://172.16.0.1'))
        .rejects.toThrow(/private\/internal/);
    });

    it('should block 169.254.x.x (link-local)', async () => {
      await expect(assertUrlSafe('http://169.254.1.1'))
        .rejects.toThrow(/private\/internal/);
    });

    it('should block ::1 (IPv6 loopback)', async () => {
      await expect(assertUrlSafe('http://[::1]:3000'))
        .rejects.toThrow(/private\/internal/);
    });

    it('should block 0.x.x.x', async () => {
      await expect(assertUrlSafe('http://0.0.0.0'))
        .rejects.toThrow(/private\/internal/);
    });
  });

  describe('assertUrlSafe – DNS resolution checks', () => {
    it('should block hostnames that resolve to 10.x.x.x', async () => {
      mockLookup.mockResolvedValue({ address: '10.0.0.1', family: 4 });
      await expect(assertUrlSafe('http://evil.example.com'))
        .rejects.toThrow(/resolves to private IP/);
    });

    it('should block hostnames that resolve to 192.168.x.x', async () => {
      mockLookup.mockResolvedValue({ address: '192.168.1.100', family: 4 });
      await expect(assertUrlSafe('http://internal.corp.com'))
        .rejects.toThrow(/resolves to private IP/);
    });

    it('should block hostnames that resolve to 172.16.x.x', async () => {
      mockLookup.mockResolvedValue({ address: '172.16.0.1', family: 4 });
      await expect(assertUrlSafe('http://sneaky.example.com'))
        .rejects.toThrow(/resolves to private IP/);
    });

    it('should block hostnames that resolve to 127.0.0.1', async () => {
      mockLookup.mockResolvedValue({ address: '127.0.0.1', family: 4 });
      await expect(assertUrlSafe('http://redirect-to-local.example.com'))
        .rejects.toThrow(/resolves to private IP/);
    });

    it('should block IPv6-mapped IPv4 loopback (::ffff:127.0.0.1)', async () => {
      mockLookup.mockResolvedValue({ address: '::ffff:127.0.0.1', family: 6 });
      await expect(assertUrlSafe('http://tricky.example.com'))
        .rejects.toThrow(/resolves to private IP/);
    });

    it('should block IPv6 loopback (::1)', async () => {
      mockLookup.mockResolvedValue({ address: '::1', family: 6 });
      await expect(assertUrlSafe('http://v6-tricky.example.com'))
        .rejects.toThrow(/resolves to private IP/);
    });

    it('should block IPv6-mapped private IPs (::ffff:10.0.0.1)', async () => {
      mockLookup.mockResolvedValue({ address: '::ffff:10.0.0.1', family: 6 });
      await expect(assertUrlSafe('http://mapped.example.com'))
        .rejects.toThrow(/resolves to private IP/);
    });

    it('should allow hostnames that resolve to public IPs', async () => {
      mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
      await expect(assertUrlSafe('http://example.com')).resolves.toBeUndefined();
    });

    it('should allow when DNS resolution fails (non-security error)', async () => {
      mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
      await expect(assertUrlSafe('http://nonexistent.example.com')).resolves.toBeUndefined();
    });
  });
});
