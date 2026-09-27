import { memo, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult, LLMProvider,DiffLine,DiffStats,Project,ToolGroupItem } from '@/shared/types';
import { getToolConfig } from '@/modules/chat/tools';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';
import { DiffStatsBadge } from '@/modules/chat/tools/DiffStatsBadge';
import { parseToolPayload, summarizeDiff } from '@/modules/chat/utils/messageTransforms';
import { MIXED_TOOL_GROUP } from '@/modules/chat/utils/toolGrouping';

type ToolGroupContainerProps = {
  group: ToolGroupItem;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  getMessageKey: (message: ChatMessage) => string;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  provider: LLMProvider | string;
};

/**
 * Totals the lines a run of file edits added and removed.
 *
 * A collapsed group hides every individual diff behind `x4`, so without this
 * the one thing the row could usefully say about a batch of edits — how big it
 * is — is the one thing it did not. Returns null for groups of tools that do
 * not render a diff at all.
 */
function useGroupDiffStats(
  messages: ChatMessage[],
  createDiff: (oldStr: string, newStr: string) => DiffLine[],
): DiffStats | null {
  return useMemo(() => {
    let added = 0;
    let removed = 0;
    let counted = 0;

    // Per message rather than per group: a mixed run can hold Edits, Writes and
    // Reads, and only the ones that render a diff contribute.
    for (const message of messages) {
      const config = getToolConfig(message.toolName || 'UnknownTool').input;
      if (config.contentType !== 'diff' || !config.getContentProps) {
        continue;
      }
      const contentProps = config.getContentProps(parseToolPayload(message.toolInput) ?? {});
      if (typeof contentProps?.oldContent !== 'string' || typeof contentProps?.newContent !== 'string') {
        continue;
      }

      const stats = summarizeDiff(createDiff(contentProps.oldContent, contentProps.newContent));
      added += stats.added;
      removed += stats.removed;
      counted += 1;
    }

    return counted > 0 ? { added, removed } : null;
  }, [createDiff, messages]);
}

function getToolGroupIcon(icon: string | undefined, toolName: string): string {
  if (icon === 'terminal') {
    return '$';
  }

  return icon || toolName.slice(0, 1).toUpperCase();
}

/**
 * Rendered by chat's ChatMessagesPane to collapse a run of consecutive tool
 * calls into a single expandable group in the transcript.
 */
function ToolGroupContainer({
  group,
  prevMessage,
  createDiff,
  getMessageKey,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
  provider,
}: ToolGroupContainerProps) {
  const isExporting = useIsExportingTranscript();
  // Collapsed on screen, always open in an export: the whole point of the
  // group row is to hide detail the reader can ask for, and an exported file
  // has no way to ask.
  const [isExpanded, setIsExpanded] = useState(false);
  const showChildren = isExpanded || isExporting;
  const isMixed = group.toolName === MIXED_TOOL_GROUP;
  const config = getToolConfig(isMixed ? 'Default' : group.toolName).input;
  const count = group.messages.length;
  const label = isMixed ? `${count} steps` : config.label || group.toolName;
  const icon = isMixed ? '\u22EF' : getToolGroupIcon(config.icon, group.toolName);
  const failedCount = group.messages.filter((message) => message.toolResult?.isError).length;

  const preview = group.preview;
  const groupDiffStats = useGroupDiffStats(group.messages, createDiff);

  return (
    <div className="chat-message tool px-3 sm:px-0" data-message-timestamp={group.timestamp || undefined}>
      <button
        type="button"
        className="group flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
        onClick={() => setIsExpanded((current) => !current)}
        aria-expanded={isExpanded}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          aria-hidden
        />
        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-[11px]">{icon}</span>
        <span className="min-w-0 flex-shrink-0 text-xs font-medium">{label}</span>
        {!isMixed && count > 1 && (
          <span className="flex-shrink-0 text-[11px] text-muted-foreground/70">x{count}</span>
        )}
        {preview && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/70">{preview}</span>
        )}
        {failedCount > 0 && (
          <span className="flex-shrink-0 text-[11px] text-red-500">{failedCount} failed</span>
        )}
        {groupDiffStats && <DiffStatsBadge stats={groupDiffStats} className="ml-auto pl-2" />}
      </button>

      {showChildren && (
        <div className="mt-2 space-y-3 sm:space-y-4">
          {group.messages.map((message, index) => (
            <MessageComponent
              key={getMessageKey(message)}
              message={message}
              prevMessage={index > 0 ? group.messages[index - 1] : prevMessage}
              createDiff={createDiff}
              onFileOpen={onFileOpen}
              onShowSettings={onShowSettings}
              onGrantToolPermission={onGrantToolPermission}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              selectedProject={selectedProject}
              provider={provider}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Memoized for the transcript re-renders that are not message changes — the
 * pane re-renders when isProcessing or the activity indicator flips, and the
 * group is unchanged then.
 *
 * It cannot bail during streaming: groupConsecutiveTools rebuilds every group
 * object from a fresh visibleMessages array on each 100ms tick, so `group` is a
 * new reference even when its contents are identical. Stabilizing it would mean
 * keying a cache on the whole run — first and second message identity, run
 * length and showThinking — because the preview depends on all four.
 */
export default memo(ToolGroupContainer);
