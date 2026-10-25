import type { Message } from '@earendil-works/pi-ai';

/** Only complete assistant/tool groups survive trimming or process recovery. */
export function recentTurns(messages: Message[]): Message[] {
  const groups: Message[][] = [];
  let current: Message[] = [];
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant') {
      if (
        message.role === 'user' ||
        current.some((m) => m.role === 'assistant')
      ) {
        if (current.length) groups.push(current);
        current = [];
      }
    }
    current.push(message);
  }
  if (current.length) groups.push(current);
  return groups
    .filter((group) => {
      const assistant = group.find((m) => m.role === 'assistant');
      if (
        !assistant ||
        assistant.role !== 'assistant' ||
        ['error', 'aborted'].includes(assistant.stopReason)
      )
        return false;
      return assistant.content
        .filter((c) => c.type === 'toolCall')
        .every((c) =>
          group.some((m) => m.role === 'toolResult' && m.toolCallId === c.id),
        );
    })
    .slice(-8)
    .flat();
}

/** An interaction includes the human input and every complete model/tool turn. */
export function recentInteractions(messages: Message[]): Message[] {
  const interactions: Message[][] = [];
  let current: Message[] | undefined;
  for (const message of messages) {
    if (message.role === 'user') {
      current = [message];
      interactions.push(current);
    } else if (current && message.role !== 'system') current.push(message);
  }
  return interactions.slice(-8).flatMap((group) => {
    const retained: Message[] = [group[0]];
    for (let i = 1; i < group.length; ) {
      const assistant = group[i++];
      if (assistant.role !== 'assistant') continue;
      const results: Message[] = [];
      while (i < group.length && group[i].role === 'toolResult')
        results.push(group[i++]);
      if (['error', 'aborted'].includes(assistant.stopReason)) continue;
      if (
        assistant.content
          .filter((c) => c.type === 'toolCall')
          .every((c) =>
            results.some(
              (r) => r.role === 'toolResult' && r.toolCallId === c.id,
            ),
          )
      )
        retained.push(assistant, ...results);
    }
    return retained;
  });
}

/**
 * The base transcript slice one provider request may see: every system message,
 * the current human input, and the complete groups retained around it. The
 * protocol correction, when queued, is appended by the caller.
 */
export function decisionWindow(
  messages: Message[],
  interactionHistory: boolean,
): Message[] {
  const retained = new Set(
    (interactionHistory ? recentInteractions : recentTurns)(messages),
  );
  const input = messages.filter((message) => message.role === 'user').at(-1);
  return messages.filter(
    (message) =>
      message.role === 'system' || message === input || retained.has(message),
  );
}
