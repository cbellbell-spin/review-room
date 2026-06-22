type ShareRuntimeCapabilities = {
  canComment: boolean;
  canEdit: boolean;
  canReply: boolean;
  canResolve: boolean;
  canDecideSuggestions: boolean;
};

let runtimeCapabilities: ShareRuntimeCapabilities = {
  canComment: true,
  canEdit: true,
  canReply: true,
  canResolve: true,
  canDecideSuggestions: true,
};

export function setShareRuntimeCapabilities(capabilities: Partial<ShareRuntimeCapabilities>): void {
  runtimeCapabilities = {
    canComment: capabilities.canComment ?? runtimeCapabilities.canComment,
    canEdit: capabilities.canEdit ?? runtimeCapabilities.canEdit,
    canReply: capabilities.canReply ?? runtimeCapabilities.canReply,
    canResolve: capabilities.canResolve ?? runtimeCapabilities.canResolve,
    canDecideSuggestions: capabilities.canDecideSuggestions ?? runtimeCapabilities.canDecideSuggestions,
  };
}

export function resetShareRuntimeCapabilities(): void {
  runtimeCapabilities = {
    canComment: true,
    canEdit: true,
    canReply: true,
    canResolve: true,
    canDecideSuggestions: true,
  };
}

export function canCommentInRuntime(): boolean {
  return runtimeCapabilities.canComment;
}

export function canEditInRuntime(): boolean {
  return runtimeCapabilities.canEdit;
}

export function canReplyInRuntime(): boolean {
  return runtimeCapabilities.canReply;
}

export function canResolveInRuntime(): boolean {
  return runtimeCapabilities.canResolve;
}

export function canDecideSuggestionsInRuntime(): boolean {
  return runtimeCapabilities.canDecideSuggestions;
}
