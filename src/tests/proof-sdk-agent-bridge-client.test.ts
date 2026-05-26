import {
  buildBridgePath,
  buildDocumentPath,
  buildEventsPath,
  createAgentBridgeClient,
  type AgentProvider,
} from '../../packages/agent-bridge/src/index.ts';

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function run(): Promise<void> {
  assertEqual(buildDocumentPath('hello world'), '/documents/hello%20world');
  assertEqual(buildBridgePath('doc-1', '/comments'), '/documents/doc-1/bridge/comments');
  assertEqual(buildEventsPath('doc-1', 12, 25), '/documents/doc-1/events/pending?after=12&limit=25');

  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = createAgentBridgeClient({
    baseUrl: 'https://example.com/',
    auth: {
      shareToken: 'token-123',
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }) as typeof fetch,
  });

  await client.addComment('doc-1', {
    by: 'ai:test',
    quote: 'Hello',
    text: 'Tighten the opener.',
  });
  await client.setPresence('doc-1', {
    agentId: 'agent:test',
    status: 'reviewing',
  });
  await client.getPendingEvents('doc-1', 4, 10);

  assertEqual(requests.length, 3, 'Expected three bridge client requests');
  assertEqual(requests[0]?.url, 'https://example.com/documents/doc-1/bridge/comments');
  assertEqual(requests[1]?.url, 'https://example.com/documents/doc-1/presence');
  assertEqual(requests[2]?.url, 'https://example.com/documents/doc-1/events/pending?after=4&limit=10');
  assertEqual(
    (requests[0]?.init.headers as Record<string, string>)?.['x-share-token'],
    'token-123',
    'Expected share token header',
  );
  assertEqual(
    (requests[0]?.init.headers as Record<string, string>)?.['x-proof-client-protocol'],
    '3',
    'Expected Proof client protocol header',
  );
  assertEqual(
    (requests[0]?.init.headers as Record<string, string>)?.['Content-Type'],
    'application/json',
    'Expected JSON content type for POST requests',
  );

  const provider: AgentProvider = {
    async complete(request) {
      return {
        message: {
          role: 'assistant',
          content: request.messages.map((message) => message.content).join('\n'),
        },
      };
    },
  };
  const providerResponse = await provider.complete({
    messages: [
      { role: 'user', content: 'Review this draft.' },
    ],
  });
  assertEqual(providerResponse.message.content, 'Review this draft.');

  console.log('proof-sdk-agent-bridge-client.test.ts: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
