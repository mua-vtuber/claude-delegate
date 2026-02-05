// ============================================
// State Storage & Cleanup
// ============================================

import type { ThinkingStep, GraphNode, GraphRelation, AnalysisResult, SystemProfile, CodeReviewSession, CodeDiscussionSession } from "./types.js";

export const thinkingSteps: Map<string, ThinkingStep[]> = new Map();
export const knowledgeGraph: { nodes: GraphNode[]; relations: GraphRelation[] } = { nodes: [], relations: [] };
// Node index for O(1) lookups
export const nodeIndex: Map<string, number> = new Map();
export const responseCache: Map<string, { response: string; timestamp: number; ttl: number }> = new Map();
export const envOverrides: Map<string, string> = new Map();
export const backgroundProcesses: Map<string, { pid: number; command: string; startTime: number }> = new Map();
export const promptTemplates: Map<string, string> = new Map();

// Analysis cache for trend tracking
export const analysisCache: Map<string, { result: AnalysisResult; timestamp: number }> = new Map();

// Code review collaborative session storage
export const reviewSessions: Map<string, CodeReviewSession> = new Map();

// Code discussion session storage (solution-focused)
export const discussionSessions: Map<string, CodeDiscussionSession> = new Map();

// System profile cache for VRAM-aware routing
export let cachedSystemProfile: SystemProfile | null = null;
export function setCachedSystemProfile(p: SystemProfile | null): void {
  cachedSystemProfile = p;
}

// ============================================
// Resource Cleanup Configuration
// ============================================

const MAX_CACHE_SIZE = 1000;
const MAX_ANALYSIS_CACHE_SIZE = 500;
const MAX_THINKING_SESSIONS = 100;
const CACHE_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MAX_REVIEW_SESSIONS = 5;
const REVIEW_SESSION_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const MAX_DISCUSSION_SESSIONS = 5;
const DISCUSSION_SESSION_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

function cleanupExpiredCache() {
  const now = Date.now();
  for (const [key, value] of responseCache.entries()) {
    if (now > value.timestamp + value.ttl * 1000) {
      responseCache.delete(key);
    }
  }
  // Enforce max size (remove oldest)
  if (responseCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(responseCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = entries.slice(0, responseCache.size - MAX_CACHE_SIZE);
    toDelete.forEach(([key]) => responseCache.delete(key));
  }
  // Enforce analysis cache max size
  if (analysisCache.size > MAX_ANALYSIS_CACHE_SIZE) {
    const entries = Array.from(analysisCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = entries.slice(0, analysisCache.size - MAX_ANALYSIS_CACHE_SIZE);
    toDelete.forEach(([key]) => analysisCache.delete(key));
  }
}

function cleanupThinkingSessions() {
  if (thinkingSteps.size > MAX_THINKING_SESSIONS) {
    const keys = Array.from(thinkingSteps.keys());
    keys.slice(0, thinkingSteps.size - MAX_THINKING_SESSIONS).forEach(k => thinkingSteps.delete(k));
  }
}

function cleanupBackgroundProcesses() {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  for (const [id, proc] of backgroundProcesses.entries()) {
    if (now - proc.startTime > ONE_HOUR) {
      try { process.kill(proc.pid); } catch { /* already dead */ }
      backgroundProcesses.delete(id);
    }
  }
}

function cleanupReviewSessions() {
  const now = Date.now();
  for (const [id, session] of reviewSessions.entries()) {
    if (now - session.last_activity > REVIEW_SESSION_EXPIRY_MS) {
      reviewSessions.delete(id);
    }
    if (session.status === "completed") {
      reviewSessions.delete(id);
    }
  }
  if (reviewSessions.size > MAX_REVIEW_SESSIONS) {
    const entries = Array.from(reviewSessions.entries())
      .sort((a, b) => a[1].last_activity - b[1].last_activity);
    const toDelete = entries.slice(0, reviewSessions.size - MAX_REVIEW_SESSIONS);
    toDelete.forEach(([key]) => reviewSessions.delete(key));
  }
}

function cleanupDiscussionSessions() {
  const now = Date.now();
  for (const [id, session] of discussionSessions.entries()) {
    if (now - session.last_activity > DISCUSSION_SESSION_EXPIRY_MS) {
      discussionSessions.delete(id);
    }
    if (session.status === "completed") {
      discussionSessions.delete(id);
    }
  }
  if (discussionSessions.size > MAX_DISCUSSION_SESSIONS) {
    const entries = Array.from(discussionSessions.entries())
      .sort((a, b) => a[1].last_activity - b[1].last_activity);
    const toDelete = entries.slice(0, discussionSessions.size - MAX_DISCUSSION_SESSIONS);
    toDelete.forEach(([key]) => discussionSessions.delete(key));
  }
}

// Store timer reference for graceful shutdown
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startCleanupTimers(): void {
  cleanupTimer = setInterval(() => {
    cleanupExpiredCache();
    cleanupThinkingSessions();
    cleanupBackgroundProcesses();
    cleanupReviewSessions();
    cleanupDiscussionSessions();
  }, CACHE_CLEANUP_INTERVAL);
}

export function stopCleanupTimers(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export function cleanupAllBackgroundProcesses(): void {
  for (const [id, proc] of backgroundProcesses.entries()) {
    try { process.kill(proc.pid); } catch { /* already dead */ }
    backgroundProcesses.delete(id);
  }
}
