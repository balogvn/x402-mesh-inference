import { UpstreamError } from "@x402-mesh/shared";

/**
 * Server-Sent Events framing.
 *
 * The naive implementation — `JSON.parse` on every network chunk — is wrong, and wrong in a
 * way that only shows up under load. A chunk boundary is a TCP artefact: it can land in the
 * middle of a JSON object, between the `data: ` prefix and its payload, between the two
 * newlines that end a frame, or between the `\r` and the `\n` of a CRLF. A single chunk can
 * equally carry a dozen complete frames. This parser therefore buffers across chunks and
 * only emits whole frames.
 */

/** Sentinel payload OpenAI-compatible servers send to close a stream. */
export const SSE_DONE = "[DONE]";

/** One dispatched SSE event. `data` has already had its `data:` prefixes removed. */
export interface SseEvent {
  /** Concatenation of the frame's `data:` lines, joined with `\n`. */
  data: string;
  /** Value of the frame's `event:` field, when present. */
  event?: string;
  /** Value of the frame's `id:` field, when present. */
  id?: string;
}

/**
 * Incremental SSE frame parser.
 *
 * Feed it decoded text with {@link push}; it returns the events that became complete. Call
 * {@link flush} once the transport closes to pick up a trailing frame that was not followed
 * by a blank line — real servers do omit it.
 *
 * Once a `data: [DONE]` frame is seen the parser latches {@link done} and stops emitting, so
 * bytes a server sends after the sentinel cannot inject extra completion chunks.
 */
export class SseParser {
  private buffer = "";
  private pendingCr = false;
  private finished = false;

  /** True once `[DONE]` has been seen. No further events will be emitted. */
  get done(): boolean {
    return this.finished;
  }

  /** Bytes buffered but not yet forming a complete frame. Exposed for tests and diagnostics. */
  get pending(): string {
    return this.pendingCr ? `${this.buffer}\r` : this.buffer;
  }

  /**
   * Consumes a decoded text chunk and returns every event it completed.
   *
   * @param chunk - Any slice of the stream, including a partial line or partial JSON.
   */
  push(chunk: string): SseEvent[] {
    if (this.finished || chunk.length === 0) return [];
    this.append(chunk);

    const events: SseEvent[] = [];
    for (;;) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary === -1) break;
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      if (this.emit(frame, events)) return events;
    }
    return events;
  }

  /**
   * Parses whatever is left in the buffer as a final frame.
   *
   * Idempotent: the buffer is cleared, so a second call returns nothing.
   */
  flush(): SseEvent[] {
    if (this.finished) return [];
    if (this.pendingCr) {
      this.buffer += "\n";
      this.pendingCr = false;
    }
    const rest = this.buffer;
    this.buffer = "";
    if (rest.trim().length === 0) return [];
    const events: SseEvent[] = [];
    this.emit(rest, events);
    return events;
  }

  /**
   * Appends a chunk, normalizing CR and CRLF terminators to LF.
   *
   * A trailing `\r` is withheld rather than translated: the very next chunk may open with the
   * `\n` that completes a CRLF, and translating eagerly would manufacture a frame boundary
   * that is not there.
   */
  private append(chunk: string): void {
    let text = chunk;
    if (this.pendingCr) {
      this.pendingCr = false;
      this.buffer += "\n";
      if (text.startsWith("\n")) text = text.slice(1);
    }
    if (text.endsWith("\r")) {
      this.pendingCr = true;
      text = text.slice(0, -1);
    }
    this.buffer += text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  /**
   * Parses one raw frame and appends the resulting event to `out`.
   *
   * @returns True when the frame was the `[DONE]` sentinel and parsing must stop.
   */
  private emit(frame: string, out: SseEvent[]): boolean {
    const dataLines: string[] = [];
    let eventName: string | undefined;
    let id: string | undefined;

    for (const line of frame.split("\n")) {
      // A line beginning with a colon is a comment (commonly a `: keep-alive` ping).
      if (line.length === 0 || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      // Exactly one optional leading space after the colon is part of the framing.
      if (value.startsWith(" ")) value = value.slice(1);

      switch (field) {
        case "data":
          dataLines.push(value);
          break;
        case "event":
          eventName = value;
          break;
        case "id":
          id = value;
          break;
        default:
          // `retry:` and unknown fields carry no payload we act on.
          break;
      }
    }

    if (dataLines.length === 0) return false;
    const data = dataLines.join("\n");
    if (data === SSE_DONE) {
      this.finished = true;
      return true;
    }
    const event: SseEvent = { data };
    if (eventName !== undefined) event.event = eventName;
    if (id !== undefined) event.id = id;
    out.push(event);
    return false;
  }
}

/** Anything a `fetch` response body can be: a web stream or a Node async iterable of bytes. */
export type ByteStream = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

/** Adapts either body flavour to a plain async iterable, so tests can stub with a generator. */
async function* toAsyncIterable(stream: ByteStream): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in stream) {
    yield* stream as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Decodes a byte stream and yields the JSON payload of every SSE `data:` frame.
 *
 * Terminates cleanly at `[DONE]`. The `TextDecoder` runs in streaming mode so a multi-byte
 * UTF-8 character split across chunks is reassembled rather than replaced with U+FFFD.
 *
 * @param stream - Response body.
 * @param label - Upstream name used in error messages.
 * @throws {UpstreamError} if a frame's payload is not valid JSON.
 */
export async function* iterateSseJson<T>(stream: ByteStream, label: string): AsyncGenerator<T> {
  const parser = new SseParser();
  const decoder = new TextDecoder("utf-8");

  for await (const bytes of toAsyncIterable(stream)) {
    for (const event of parser.push(decoder.decode(bytes, { stream: true }))) {
      yield parseFrame<T>(event.data, label);
    }
    if (parser.done) return;
  }

  const tail = decoder.decode();
  if (tail.length > 0) {
    for (const event of parser.push(tail)) {
      yield parseFrame<T>(event.data, label);
    }
    if (parser.done) return;
  }
  for (const event of parser.flush()) {
    yield parseFrame<T>(event.data, label);
  }
}

function parseFrame<T>(data: string, label: string): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    throw new UpstreamError(`${label} sent a malformed SSE frame`, {
      // Bounded so a runaway body cannot flood the log; `details` is truncated again on
      // serialization by the shared error sanitizer.
      frame: data.slice(0, 200),
    });
  }
}
