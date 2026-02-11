import { describe, it, expect } from 'vitest';
import { estimateComplexity, selectOllamaModel, OLLAMA_MODELS } from '../helpers/routing.js';

describe('routing', () => {
  describe('estimateComplexity', () => {
    it('should return "low" for short simple prompts', () => {
      expect(estimateComplexity('What is this?')).toBe('low');
      expect(estimateComplexity('간단히 설명해')).toBe('low');
      expect(estimateComplexity('Simply explain')).toBe('low');
      expect(estimateComplexity('뭐야?')).toBe('low');
      expect(estimateComplexity('Quick question')).toBe('low');
    });

    it('should return "medium" for prompts with code blocks', () => {
      const promptWithCode = 'Explain this code: ```js\nfunction test() {}\n```';
      expect(estimateComplexity(promptWithCode)).toBe('medium');
    });

    it('should return "medium" for moderately long prompts', () => {
      const longPrompt = 'a '.repeat(150); // 300 words
      expect(estimateComplexity(longPrompt)).toBe('medium');
    });

    it('should return "high" for multi-file prompts', () => {
      const multiFilePrompt = 'Analyze @src/test.ts @src/another.ts @src/third.ts';
      expect(estimateComplexity(multiFilePrompt)).toBe('high');
    });

    it('should return "high" for very long prompts', () => {
      const veryLongPrompt = 'a '.repeat(600); // 1200 words
      expect(estimateComplexity(veryLongPrompt)).toBe('high');
    });

    it('should return "high" for prompts with complex keywords (English)', () => {
      expect(estimateComplexity('architect the system')).toBe('high');
      expect(estimateComplexity('refactor this code')).toBe('high');
      expect(estimateComplexity('analyze the bug')).toBe('high');
      expect(estimateComplexity('debug the error')).toBe('high');
      expect(estimateComplexity('optimize performance')).toBe('high');
      expect(estimateComplexity('security review')).toBe('high');
    });

    it('should recognize Korean complex keywords', () => {
      expect(estimateComplexity('설계해줘')).toBe('high');
      expect(estimateComplexity('분석해줘')).toBe('high');
      expect(estimateComplexity('리팩토링해줘')).toBe('high');
      expect(estimateComplexity('디버그해줘')).toBe('high');
      expect(estimateComplexity('최적화해줘')).toBe('high');
      expect(estimateComplexity('버그 찾아줘')).toBe('high');
      expect(estimateComplexity('에러 해결해줘')).toBe('high');
    });

    it('should recognize Korean simple keywords', () => {
      expect(estimateComplexity('뭐야 이거')).toBe('low');
      expect(estimateComplexity('간단히 설명해')).toBe('low');
      expect(estimateComplexity('빨리 확인해')).toBe('low');
      expect(estimateComplexity('번역해줘')).toBe('low');
      expect(estimateComplexity('요약해줘')).toBe('low');
      expect(estimateComplexity('읽어줘')).toBe('low');
    });
  });

  describe('selectOllamaModel', () => {
    it('should respect forceModel parameter', () => {
      const result = selectOllamaModel('any prompt', 'custom-model');
      expect(result.model).toBe('custom-model');
      expect(result.reason).toContain('User specified');
    });

    it('should ignore forceModel if set to "auto"', () => {
      const result = selectOllamaModel('architect the system', 'auto');
      expect(result.model).toBe(OLLAMA_MODELS.powerful);
      expect(result.reason).toContain('Auto-selected');
    });

    it('should map "low" complexity to light model', () => {
      const result = selectOllamaModel('What is this?');
      expect(result.model).toBe(OLLAMA_MODELS.light);
      expect(result.reason).toContain('7B');
      expect(result.reason).toContain('complexity: low');
    });

    it('should map "medium" complexity to fast model', () => {
      const result = selectOllamaModel('Explain this code: ```js\nfunction test() {}\n```');
      expect(result.model).toBe(OLLAMA_MODELS.fast);
      expect(result.reason).toContain('14B');
      expect(result.reason).toContain('complexity: medium');
    });

    it('should map "high" complexity to powerful model', () => {
      const result = selectOllamaModel('architect the system');
      expect(result.model).toBe(OLLAMA_MODELS.powerful);
      expect(result.reason).toContain('32B');
      expect(result.reason).toContain('complexity: high');
    });

    it('should handle Korean prompts correctly', () => {
      const lowResult = selectOllamaModel('뭐야?');
      expect(lowResult.model).toBe(OLLAMA_MODELS.light);

      const highResult = selectOllamaModel('설계해줘');
      expect(highResult.model).toBe(OLLAMA_MODELS.powerful);
    });
  });
});
