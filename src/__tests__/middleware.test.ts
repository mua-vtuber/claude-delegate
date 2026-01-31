import { describe, it, expect, vi } from 'vitest';

// Mock logger to prevent file I/O during tests
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { validateArgs } from '../middleware.js';

describe('middleware – validateArgs', () => {
  // ── Valid args pass validation ──

  describe('valid arguments', () => {
    it('should accept valid ollama_chat args and apply defaults', () => {
      const result = validateArgs('ollama_chat', { prompt: 'Hello' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.prompt).toBe('Hello');
        expect(result.data.model).toBe('auto'); // schema default
      }
    });

    it('should accept valid shell_execute args', () => {
      const result = validateArgs('shell_execute', { command: 'ls', args: ['-la'] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.command).toBe('ls');
        expect(result.data.args).toEqual(['-la']);
      }
    });

    it('should accept valid fs_read_file args', () => {
      const result = validateArgs('fs_read_file', { file_path: './test.txt' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.file_path).toBe('./test.txt');
      }
    });

    it('should accept valid todo_manager args with enum', () => {
      const result = validateArgs('todo_manager', { action: 'add', task: 'Do something' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('add');
        expect(result.data.task).toBe('Do something');
      }
    });

    it('should accept valid sqlite_query args', () => {
      const result = validateArgs('sqlite_query', { db_path: 'data.db', query: 'SELECT 1' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.db_path).toBe('data.db');
        expect(result.data.query).toBe('SELECT 1');
      }
    });
  });

  // ── Invalid args return structured error ──

  describe('invalid arguments', () => {
    it('should return error when required "prompt" is missing for ollama_chat', () => {
      const result = validateArgs('ollama_chat', {});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.isError).toBe(true);
        expect(result.error.content[0].text).toContain('Validation error for ollama_chat');
      }
    });

    it('should return error when required "file_path" is wrong type for fs_read_file', () => {
      const result = validateArgs('fs_read_file', { file_path: 123 as any });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.isError).toBe(true);
        expect(result.error.content[0].text).toContain('Validation error');
      }
    });

    it('should return error for invalid enum value in todo_manager', () => {
      const result = validateArgs('todo_manager', { action: 'destroy' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.isError).toBe(true);
        expect(result.error.content[0].text).toContain('Validation error for todo_manager');
      }
    });

    it('should return error when command is missing for shell_execute', () => {
      const result = validateArgs('shell_execute', {});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.isError).toBe(true);
      }
    });

    it('should return error for wrong array type in shell_execute args', () => {
      const result = validateArgs('shell_execute', { command: 'ls', args: 'not-an-array' as any });
      expect(result.success).toBe(false);
    });
  });

  // ── Tools without schemas pass through ──

  describe('tools without schemas', () => {
    it('should pass through args for unknown tools', () => {
      const result = validateArgs('nonexistent_tool_xyz', { foo: 'bar', count: 42 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ foo: 'bar', count: 42 });
      }
    });

    it('should return empty object when args are undefined for unknown tool', () => {
      const result = validateArgs('nonexistent_tool_xyz', undefined);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({});
      }
    });
  });

  // ── Default value application ──

  describe('default values', () => {
    it('should apply default model "auto" for ollama_chat', () => {
      const result = validateArgs('ollama_chat', { prompt: 'test' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.model).toBe('auto');
      }
    });

    it('should apply default dir_path for fs_list_directory', () => {
      const result = validateArgs('fs_list_directory', {});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.dir_path).toBe('.');
      }
    });

    it('should allow overriding defaults', () => {
      const result = validateArgs('ollama_chat', { prompt: 'test', model: 'custom-model' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.model).toBe('custom-model');
      }
    });
  });
});
