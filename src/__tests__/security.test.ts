import { describe, it, expect } from 'vitest';
import { isPathSafe, assertPathSafe, assertCommandAllowed, ALLOWED_AGENT_COMMANDS } from '../security.js';
import { PROJECT_ROOT } from '../config.js';
import { resolve, join } from 'path';

describe('security', () => {
  describe('isPathSafe', () => {
    it('should return true for paths within PROJECT_ROOT', () => {
      const safePath = join(PROJECT_ROOT, 'src', 'test.ts');
      expect(isPathSafe(safePath)).toBe(true);
    });

    it('should return true for relative paths within PROJECT_ROOT', () => {
      expect(isPathSafe('./src/test.ts')).toBe(true);
      expect(isPathSafe('src/test.ts')).toBe(true);
    });

    it('should return false for paths with ../ escaping PROJECT_ROOT', () => {
      const escapePath = join(PROJECT_ROOT, '..', '..', 'outside.ts');
      expect(isPathSafe(escapePath)).toBe(false);
    });

    it('should return false for absolute paths outside PROJECT_ROOT', () => {
      expect(isPathSafe('C:\\Windows\\System32')).toBe(false);
      expect(isPathSafe('/etc/passwd')).toBe(false);
    });
  });

  describe('assertPathSafe', () => {
    it('should return resolved path for safe paths', () => {
      const safePath = join(PROJECT_ROOT, 'src', 'test.ts');
      const result = assertPathSafe(safePath, 'test');
      expect(result).toBe(resolve(safePath));
    });

    it('should throw for unsafe paths', () => {
      const unsafePath = 'C:\\Windows\\System32';
      expect(() => assertPathSafe(unsafePath, 'test')).toThrow(/Security.*outside project directory/);
    });

    it('should throw for paths with ../ escaping PROJECT_ROOT', () => {
      const escapePath = join(PROJECT_ROOT, '..', '..', 'outside.ts');
      expect(() => assertPathSafe(escapePath, 'test')).toThrow(/Security.*outside project directory/);
    });
  });

  describe('assertCommandAllowed', () => {
    it('should reject dangerous commands', () => {
      expect(() => assertCommandAllowed('rm')).toThrow(/not in the agent allowlist/);
      expect(() => assertCommandAllowed('del')).toThrow(/not in the agent allowlist/);
      expect(() => assertCommandAllowed('shutdown')).toThrow(/not in the agent allowlist/);
      expect(() => assertCommandAllowed('format')).toThrow(/not in the agent allowlist/);
      expect(() => assertCommandAllowed('powershell')).toThrow(/not in the agent allowlist/);
    });

    it('should accept safe commands', () => {
      expect(() => assertCommandAllowed('ls')).not.toThrow();
      expect(() => assertCommandAllowed('dir')).not.toThrow();
      expect(() => assertCommandAllowed('git')).not.toThrow();
      expect(() => assertCommandAllowed('node')).not.toThrow();
      expect(() => assertCommandAllowed('npm')).not.toThrow();
    });

    it('should handle commands with .exe extension', () => {
      expect(() => assertCommandAllowed('node.exe')).not.toThrow();
      expect(() => assertCommandAllowed('git.exe')).not.toThrow();
    });

    it('should handle command paths', () => {
      expect(() => assertCommandAllowed('/usr/bin/git')).not.toThrow();
      expect(() => assertCommandAllowed('C:\\Program Files\\Git\\bin\\git.exe')).not.toThrow();
    });
  });

  describe('ALLOWED_AGENT_COMMANDS', () => {
    it('should contain expected defaults', () => {
      const expectedCommands = ['ls', 'dir', 'cat', 'type', 'find', 'grep', 'rg', 'node', 'npm', 'git', 'echo', 'pwd'];
      expectedCommands.forEach(cmd => {
        expect(ALLOWED_AGENT_COMMANDS.has(cmd)).toBe(true);
      });
    });

    it('should be a Set', () => {
      expect(ALLOWED_AGENT_COMMANDS).toBeInstanceOf(Set);
    });

    it('should not contain dangerous commands', () => {
      const dangerousCommands = ['rm', 'del', 'shutdown', 'format', 'powershell'];
      dangerousCommands.forEach(cmd => {
        expect(ALLOWED_AGENT_COMMANDS.has(cmd)).toBe(false);
      });
    });
  });
});
