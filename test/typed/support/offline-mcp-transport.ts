import type { McpTransportFactory } from '@earendil-works/pi-coding-agent';

type Transport = ReturnType<McpTransportFactory>;
type Message = Parameters<Parameters<Transport['onMessage']>[0]>[0];
type Request = Extract<Message, { id: unknown; method: string }>;

/**
 * In-process wire plumbing only; each scenario supplies its own server responses.
 * `gate`, when given, keeps every reply pending until it resolves, so a scenario
 * can observe a server that has not answered yet without a timing assertion.
 */
export function offlineMcpTransport(
  respond: (request: Request) => unknown,
  { gate }: { gate?: Promise<void> } = {},
): Transport {
  const listeners = new Set<(message: Message) => void>();
  const closes = new Set<() => void>();
  return {
    start: async () => {},
    close: async () => { for (const listener of closes) listener(); },
    onMessage: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onError: () => () => {},
    onClose: listener => { closes.add(listener); return () => { closes.delete(listener); }; },
    send: async message => {
      if (!('id' in message) || !('method' in message)) return;
      const result = respond(message);
      const reply = { jsonrpc: '2.0', id: message.id, result } as Message;
      await gate;
      queueMicrotask(() => { for (const listener of listeners) listener(reply); });
    },
  };
}
