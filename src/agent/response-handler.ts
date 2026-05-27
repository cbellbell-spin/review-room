/**
 * Response handler for Review Room Agent
 *
 * Processes agent responses and:
 * - Displays thinking chain in UI
 * - Executes tool calls
 * - Updates agent cursor
 * - Applies authored marks
 * - Replies to comments
 */

import type { AgentResponse, ThinkingChainEvent, AgentTask } from './types';

// ============================================================================
// Types
// ============================================================================

export interface ResponseHandlerCallbacks {
  // UI updates
  onThinkingChainUpdate?: (events: ThinkingChainEvent[]) => void;
  onAgentCursorMove?: (position: number, label?: string) => void;
  onAgentCursorClear?: () => void;

  // Document updates
  onDocumentEdit?: (edit: DocumentEdit) => void;
  onSuggestionCreate?: (suggestion: SuggestionData) => void;
  onCommentReply?: (commentId: string, text: string) => void;

  // Status updates
  onProcessingStart?: () => void;
  onProcessingComplete?: () => void;
  onError?: (error: Error) => void;
}

export interface DocumentEdit {
  type: 'insert' | 'replace' | 'delete';
  position?: { from: number; to: number };
  text?: string;
  actor: string;
}

export interface SuggestionData {
  type: 'insert' | 'replace' | 'delete';
  position: { from: number; to: number };
  originalText?: string;
  newText?: string;
  actor: string;
}

// ============================================================================
// Response Handler Class
// ============================================================================

export class ResponseHandler {
  private callbacks: ResponseHandlerCallbacks = {};
  private thinkingChain: ThinkingChainEvent[] = [];
  private isProcessing = false;

  private static readonly AGENT_ACTOR = 'ai:review-room';

  constructor() {}

  /**
   * Set callbacks for response events
   */
  setCallbacks(callbacks: ResponseHandlerCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Process a complete agent response
   */
  async processResponse(task: AgentTask, response: AgentResponse): Promise<void> {
    this.isProcessing = true;
    this.callbacks.onProcessingStart?.();

    try {
      const repliedCommentIds = new Set<string>();

      // Update thinking chain
      this.thinkingChain = response.thinkingChain;
      this.callbacks.onThinkingChainUpdate?.(this.thinkingChain);

      // Process any tool calls that resulted in edits
      for (const toolCall of response.toolCalls) {
        const repliedCommentId = await this.processToolCallResult(toolCall);
        if (repliedCommentId) {
          repliedCommentIds.add(repliedCommentId);
        }
      }

      // If this was a comment response, only post fallback text when the
      // agent did not already reply via reply_to_comment in this thread.
      if (
        task.type === 'comment-response' &&
        task.trigger.commentId &&
        response.text &&
        !repliedCommentIds.has(task.trigger.commentId)
      ) {
        this.callbacks.onCommentReply?.(task.trigger.commentId, response.text);
      }

      // Clear agent cursor when done
      this.callbacks.onAgentCursorClear?.();
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.isProcessing = false;
      this.callbacks.onProcessingComplete?.();
    }
  }

  /**
   * Handle streaming thinking chain updates
   */
  handleThinkingUpdate(event: ThinkingChainEvent): void {
    this.thinkingChain.push(event);
    this.callbacks.onThinkingChainUpdate?.([...this.thinkingChain]);
  }

  /**
   * Handle streaming tool call
   */
  handleToolCall(name: string, args: Record<string, unknown>): void {
    // Update cursor position if this is a document operation
    if (args.position && typeof args.position === 'object') {
      const pos = args.position as { from?: number };
      if (typeof pos.from === 'number') {
        this.callbacks.onAgentCursorMove?.(pos.from, ResponseHandler.AGENT_ACTOR);
      }
    }

    // Add to thinking chain
    const event: ThinkingChainEvent = {
      type: 'tool_call',
      toolName: name,
      args,
      timestamp: Date.now(),
    };
    this.handleThinkingUpdate(event);
  }

  /**
   * Handle streaming tool result
   */
  handleToolResult(name: string, result: unknown): void {
    // Add to thinking chain
    const event: ThinkingChainEvent = {
      type: 'tool_result',
      toolName: name,
      result,
      timestamp: Date.now(),
    };
    this.handleThinkingUpdate(event);
  }

  /**
   * Handle streaming text
   */
  handleStreamingText(text: string): void {
    const event: ThinkingChainEvent = {
      type: 'text',
      content: text,
      timestamp: Date.now(),
    };
    this.handleThinkingUpdate(event);
  }

  /**
   * Process a tool call result
   */
  private async processToolCallResult(toolCall: {
    name: string;
    args: Record<string, unknown>;
    result: unknown;
    timestamp: number;
  }): Promise<string | null> {
    const { name, result } = toolCall;

    if (!result || typeof result !== 'object') {
      return null;
    }

    const resultObj = result as Record<string, unknown>;
    if (!resultObj.success) {
      return null;
    }

    // Handle document edits
    if (name === 'insert_content' || name === 'replace_content' || name === 'delete_content') {
      const edit: DocumentEdit = {
        type: name.replace('_content', '') as 'insert' | 'replace' | 'delete',
        text: (resultObj.text as string | undefined) || (resultObj.originalText as string | undefined),
        actor: ResponseHandler.AGENT_ACTOR,
      };

      if (resultObj.position && typeof resultObj.position === 'object') {
        const pos = resultObj.position as { from?: number; to?: number };
        if (typeof pos.from === 'number' && typeof pos.to === 'number') {
          edit.position = { from: pos.from, to: pos.to };
        }
      }

      this.callbacks.onDocumentEdit?.(edit);
    }

    // Handle suggestions
    if (name === 'create_suggestion') {
      const originalText =
        (resultObj.originalText as string | undefined) ||
        (resultObj.quote as string | undefined);
      const suggestion: SuggestionData = {
        type: resultObj.type as 'insert' | 'replace' | 'delete',
        position: { from: 0, to: 0 },
        originalText,
        newText: resultObj.text as string | undefined,
        actor: ResponseHandler.AGENT_ACTOR,
      };

      if (resultObj.position && typeof resultObj.position === 'object') {
        const pos = resultObj.position as { from?: number; to?: number };
        if (typeof pos.from === 'number') {
          suggestion.position.from = pos.from;
          suggestion.position.to = typeof pos.to === 'number' ? pos.to : pos.from;
        }
      }

      this.callbacks.onSuggestionCreate?.(suggestion);
    }

    // `reply_to_comment` already writes to the document inside the tool handler.
    // Do not post another reply here.
    if (name === 'reply_to_comment' && resultObj.commentId && resultObj.text) {
      return resultObj.commentId as string;
    }

    return null;
  }

  /**
   * Get the current thinking chain
   */
  getThinkingChain(): ThinkingChainEvent[] {
    return [...this.thinkingChain];
  }

  /**
   * Clear the thinking chain
   */
  clearThinkingChain(): void {
    this.thinkingChain = [];
    this.callbacks.onThinkingChainUpdate?.([]);
  }

  /**
   * Check if currently processing
   */
  isActive(): boolean {
    return this.isProcessing;
  }
}

// ============================================================================
// Global Instance
// ============================================================================

let responseHandlerInstance: ResponseHandler | null = null;

export function getResponseHandler(): ResponseHandler {
  if (!responseHandlerInstance) {
    responseHandlerInstance = new ResponseHandler();
  }
  return responseHandlerInstance;
}

export default ResponseHandler;
