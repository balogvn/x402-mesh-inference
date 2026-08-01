import { describe, expect, it } from "vitest";
import { UpstreamError } from "@x402-mesh/shared";
import { SSE_DONE, SseParser, iterateSseJson } from "../src/sse.js";

/** Feeds a whole SSE body one character at a time — the worst realistic fragmentation. */
function pushCharByChar(parser: SseParser, body: string): string[] {
  const out: string[] = [];
  for (const char of body) {
    for (const event of parser.push(char)) out.push(event.data);
  }
  for (const event of parser.flush()) out.push(event.data);
  return out;
}

async function* chunksOf(parts: string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const part of parts) yield encoder.encode(part);
}

describe("SseParser", () => {
  it("emits one event per complete frame", () => {
    const parser = new SseParser();
    const events = parser.push('data: {"a":1}\n\ndata: {"a":2}\n\n');
    expect(events.map((e) => e.data)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("reassembles a frame split mid-JSON across chunks", () => {
    const parser = new SseParser();
    // The boundary lands between `"con` and `tent":"hi"}` — a naive per-chunk JSON.parse dies.
    expect(parser.push('data: {"choices":[{"delta":{"con')).toEqual([]);
    expect(parser.push('tent":"hi"}}]}')).toEqual([]);
    const events = parser.push("\n\n");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.data)).toEqual({ choices: [{ delta: { content: "hi" } }] });
  });

  it("reassembles a frame whose terminating blank line is split across chunks", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":1}\n')).toEqual([]);
    const events = parser.push('\ndata: {"a":2}\n\n');
    expect(events.map((e) => e.data)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("reassembles a CRLF split across the chunk boundary", () => {
    const parser = new SseParser();
    // Chunk ends on the CR of a CRLF; translating it eagerly would invent a frame boundary.
    expect(parser.push('data: {"a":1}\r')).toEqual([]);
    expect(parser.push("\n\r")).toEqual([]);
    const events = parser.push("\n");
    expect(events.map((e) => e.data)).toEqual(['{"a":1}']);
  });

  it("emits every frame carried by a single multi-frame chunk", () => {
    const parser = new SseParser();
    const body = ["a", "b", "c", "d", "e"].map((v) => `data: {"v":"${v}"}\n\n`).join("");
    const events = parser.push(body);
    expect(events.map((e) => JSON.parse(e.data).v)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("terminates at [DONE] and ignores anything after it", () => {
    const parser = new SseParser();
    const events = parser.push(`data: {"a":1}\n\ndata: ${SSE_DONE}\n\ndata: {"a":"after"}\n\n`);
    expect(events.map((e) => e.data)).toEqual(['{"a":1}']);
    expect(parser.done).toBe(true);
    expect(parser.push('data: {"a":2}\n\n')).toEqual([]);
    expect(parser.flush()).toEqual([]);
  });

  it("survives one-character-at-a-time delivery of a whole stream", () => {
    const body =
      'data: {"i":0}\n\n' + ": keep-alive\n\n" + 'data: {"i":1}\n\n' + `data: ${SSE_DONE}\n\n`;
    expect(pushCharByChar(new SseParser(), body)).toEqual(['{"i":0}', '{"i":1}']);
  });

  it("joins multi-line data fields with a newline", () => {
    const parser = new SseParser();
    const events = parser.push("data: line one\ndata: line two\n\n");
    expect(events[0]?.data).toBe("line one\nline two");
  });

  it("ignores comments and blank frames but keeps event and id fields", () => {
    const parser = new SseParser();
    const events = parser.push(": ping\n\nid: 7\nevent: error\ndata: boom\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ data: "boom", event: "error", id: "7" });
  });

  it("strips exactly one leading space after the colon", () => {
    const parser = new SseParser();
    const events = parser.push("data:  two-spaces\n\ndata:none\n\n");
    expect(events.map((e) => e.data)).toEqual([" two-spaces", "none"]);
  });

  it("recovers a trailing frame that was never followed by a blank line", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"tail":true}')).toEqual([]);
    expect(parser.flush().map((e) => e.data)).toEqual(['{"tail":true}']);
    // flush is idempotent.
    expect(parser.flush()).toEqual([]);
  });
});

describe("iterateSseJson", () => {
  it("yields parsed frames across arbitrary chunk boundaries and stops at [DONE]", async () => {
    const stream = chunksOf([
      'data: {"n":',
      "1}\n\ndata: ",
      '{"n":2}\n',
      `\ndata: ${SSE_DONE}\n\n`,
      'data: {"n":3}\n\n',
    ]);
    const seen: unknown[] = [];
    for await (const frame of iterateSseJson<{ n: number }>(stream, "test")) seen.push(frame);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("reassembles a multi-byte UTF-8 character split across chunks", async () => {
    const encoded = new TextEncoder().encode('data: {"s":"é"}\n\n');
    // Split inside the two-byte sequence for "é".
    const cut = encoded.indexOf(0xc3) + 1;
    const stream = (async function* () {
      yield encoded.subarray(0, cut);
      yield encoded.subarray(cut);
    })();
    const seen: { s: string }[] = [];
    for await (const frame of iterateSseJson<{ s: string }>(stream, "test")) seen.push(frame);
    expect(seen).toEqual([{ s: "é" }]);
  });

  it("reads a web ReadableStream body as well as an async iterable", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"n":1}\n'));
        controller.enqueue(encoder.encode(`\ndata: ${SSE_DONE}\n\n`));
        controller.close();
      },
    });
    const seen: unknown[] = [];
    for await (const frame of iterateSseJson<{ n: number }>(stream, "test")) seen.push(frame);
    expect(seen).toEqual([{ n: 1 }]);
  });

  it("raises UpstreamError on a malformed frame", async () => {
    const stream = chunksOf(["data: {not json}\n\n"]);
    await expect(async () => {
      for await (const _ of iterateSseJson(stream, "ollama")) void _;
    }).rejects.toThrow(UpstreamError);
  });
});
