/**
 * Type definitions for Review Room Agent
 */

// ============================================================================
// Agent Configuration
// ============================================================================

export interface AgentConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

// ============================================================================
// Agent Task Types
// ============================================================================

export type AgentTaskType =
  | 'comment-response'  // Responding to a comment with @proof mention
  | 'document-edit'     // Direct document editing request
  | 'inline-mention'    // @proof mentioned inline in document body
  | 'research';         // Research/information gathering

export interface AgentTask {
  type: AgentTaskType;
  context: DocumentContext;
  trigger: AgentTrigger;
  prompt?: string;
}

export interface DocumentContext {
  /** Full document content */
  documentContent: string;
  /** Document metadata */
  documentId?: string;
  documentTitle?: string;
  /** Current user's identity */
  currentUser?: string;
  /** Open file paths (if multi-document access needed) */
  openFiles?: string[];
  /** Current selection range (ProseMirror positions) */
  selectionRange?: { from: number; to: number };
  /** Current cursor position (ProseMirror position) */
  cursorPosition?: number;
  /** Restrict tool actions to this range (ProseMirror positions) */
  documentRange?: { from: number; to: number };
}

export interface AgentTrigger {
  /** The @proof mention text with surrounding context */
  mentionText: string;
  /** Selected/highlighted text if any */
  selectedText?: string;
  /** Text surrounding the mention */
  surroundingText?: string;
  /** Position in document where mention occurred */
  position?: { from: number; to: number };
  /** For comments: the thread context */
  commentThread?: CommentContext[];
  /** For comments: the comment ID being responded to */
  commentId?: string;
}

export interface CommentContext {
  id: string;
  author: string;
  text: string;
  timestamp: number;
  isAgent?: boolean;
}

// ============================================================================
// Agent Response Types
// ============================================================================

export interface AgentResponse {
  /** Final text response */
  text: string;
  /** Tool calls made during execution */
  toolCalls: ToolCallRecord[];
  /** Thinking chain events */
  thinkingChain: ThinkingChainEvent[];
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  timestamp: number;
}

// ============================================================================
// Thinking Chain Types
// ============================================================================

export type ThinkingChainEventType =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'text'
  | 'error';

export interface ThinkingChainEvent {
  type: ThinkingChainEventType;
  content?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  timestamp: number;
}

// ============================================================================
// Agent Status
// ============================================================================

export type AgentStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'offline';

export interface AgentStatusInfo {
  status: AgentStatus;
  sessionId?: string;
  startedAt?: number;
  task?: AgentTaskType;
  error?: string;
}

// ============================================================================
// Tool Types
// ============================================================================

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

// ============================================================================
// Event Types for UI
// ============================================================================

export interface AgentUIEvent {
  type: 'status_change' | 'thinking_update' | 'text_stream' | 'complete' | 'error';
  data: unknown;
}
