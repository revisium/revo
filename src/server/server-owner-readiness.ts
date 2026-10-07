import { isRecord } from '../record.js';

export async function requestCoreReadiness(
  address: string,
  port: number,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`http://${address}:${String(port)}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ __typename }' }),
    signal,
  });
  const value: unknown = JSON.parse(await readBoundedResponse(response));
  if (!response.ok || !isReadyGraphql(value)) {
    throw new Error(`unexpected GraphQL response with HTTP status ${String(response.status)}`);
  }
}

function isReadyGraphql(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.errors !== undefined || !isRecord(value.data)) {
    return false;
  }
  return value.data['__typename'] === 'Query';
}

async function readBoundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('missing response');
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    const readNext = async (): Promise<string> => {
      const chunk = await reader.read();
      if (chunk.done) {
        return Buffer.concat(chunks, length).toString('utf8');
      }
      length += chunk.value.length;
      if (length > 16_384) {
        throw new Error('oversized response');
      }
      chunks.push(chunk.value);
      return readNext();
    };
    return await readNext();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
