import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_HTML = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
<script>console.log("hello");</script>
<style>body { color: red; }</style>
</body>
</html>`;

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => FAKE_HTML),
}));

function mockRes(): ServerResponse & {
  _status: number | null;
  _headers: Record<string, unknown>;
  _body: unknown;
} {
  const res = {
    _status: null as number | null,
    _headers: {} as Record<string, unknown>,
    _body: null as unknown,
    writeHead: vi.fn(function (
      this: typeof res,
      status: number,
      headers?: Record<string, unknown>,
    ) {
      this._status = status;
      if (headers) Object.assign(this._headers, headers);
    }),
    end: vi.fn(function (this: typeof res, body?: unknown) {
      if (body !== undefined) this._body = body;
    }),
  };
  return res as unknown as typeof res;
}

function mockReq(acceptEncoding?: string): IncomingMessage {
  return {
    headers: acceptEncoding !== undefined ? { "accept-encoding": acceptEncoding } : {},
  } as unknown as IncomingMessage;
}

// We need to reset modules between tests because of module-level caching
// in consumer-html.ts. Each describe block reimports the module fresh.

describe("consumer-html", () => {
  beforeEach(() => {
    vi.resetModules();
    // Re-register the mock after resetModules clears it
    vi.mock("node:fs", () => ({
      readFileSync: vi.fn(() => FAKE_HTML),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("loadConsumerHtml", () => {
    it("reads the HTML file and returns its content", async () => {
      const { loadConsumerHtml } = await import("./consumer-html.js");
      const html = loadConsumerHtml();
      expect(html).toBe(FAKE_HTML);
    });

    it("returns cached value on second call without re-reading", async () => {
      const { readFileSync } = await import("node:fs");
      const { loadConsumerHtml } = await import("./consumer-html.js");

      // First call populates the cache
      loadConsumerHtml();
      const callsAfterFirst = vi.mocked(readFileSync).mock.calls.length;

      // Second call should hit cache — no additional readFileSync
      loadConsumerHtml();
      expect(vi.mocked(readFileSync).mock.calls.length).toBe(callsAfterFirst);
    });

    it("resolves path relative to module at web/dist/index.html", async () => {
      const { readFileSync } = await import("node:fs");
      const { loadConsumerHtml } = await import("./consumer-html.js");

      loadConsumerHtml();

      const calledPath = vi.mocked(readFileSync).mock.calls[0][0] as string;
      expect(calledPath).toContain("web");
      expect(calledPath).toContain("dist");
      expect(calledPath).toContain("index.html");
    });
  });

  describe("handleConsumerHtml", () => {
    it("serves gzip when Accept-Encoding includes gzip", async () => {
      const { handleConsumerHtml } = await import("./consumer-html.js");
      const req = mockReq("gzip, deflate");
      const res = mockRes();

      handleConsumerHtml(req, res);

      expect(res._status).toBe(200);
      expect(res._headers["Content-Encoding"]).toBe("gzip");
      expect(res._headers["Content-Length"]).toBeDefined();
      // Verify the body is gzip-compressed FAKE_HTML
      const expected = gzipSync(FAKE_HTML);
      expect(Buffer.compare(res._body as Buffer, expected)).toBe(0);
    });

    it("serves plain HTML when no gzip accepted", async () => {
      const { handleConsumerHtml } = await import("./consumer-html.js");
      const req = mockReq("");
      const res = mockRes();

      handleConsumerHtml(req, res);

      expect(res._status).toBe(200);
      expect(res._headers["Content-Encoding"]).toBeUndefined();
      expect(res._body).toBe(FAKE_HTML);
    });

    it("serves plain HTML when accept-encoding header is absent", async () => {
      const { handleConsumerHtml } = await import("./consumer-html.js");
      const req = mockReq(undefined);
      const res = mockRes();

      handleConsumerHtml(req, res);

      expect(res._status).toBe(200);
      expect(res._body).toBe(FAKE_HTML);
    });

    it("includes security headers and CSP with sha256 hashes", async () => {
      const { handleConsumerHtml } = await import("./consumer-html.js");
      const req = mockReq("");
      const res = mockRes();

      handleConsumerHtml(req, res);

      expect(res._headers["X-Frame-Options"]).toBe("DENY");
      expect(res._headers["X-Content-Type-Options"]).toBe("nosniff");

      const csp = res._headers["Content-Security-Policy"] as string;
      expect(csp).toBeDefined();
      expect(csp).toContain("script-src");
      expect(csp).toContain("style-src");

      const scriptContent = 'console.log("hello");';
      const expectedScriptHash = createHash("sha256").update(scriptContent).digest("base64");
      expect(csp).toContain(`'sha256-${expectedScriptHash}'`);

      const styleContent = "body { color: red; }";
      const expectedStyleHash = createHash("sha256").update(styleContent).digest("base64");
      expect(csp).toContain(`'sha256-${expectedStyleHash}'`);
    });
  });

  describe("CSP with no inline scripts or styles", () => {
    it("uses 'none' for script-src when HTML has no scripts", async () => {
      const { readFileSync } = await import("node:fs");
      vi.mocked(readFileSync).mockReturnValue("<html><head></head><body></body></html>" as any);
      const { handleConsumerHtml } = await import("./consumer-html.js");
      const req = mockReq("");
      const res = mockRes();

      handleConsumerHtml(req, res);

      const csp = res._headers["Content-Security-Policy"] as string;
      expect(csp).toContain("script-src 'none'");
      expect(csp).toContain("style-src 'none'");
    });

    it("skips empty <script> and <style> blocks in CSP hashing", async () => {
      const { readFileSync } = await import("node:fs");
      vi.mocked(readFileSync).mockReturnValue(
        "<html><head><script></script><style></style></head></html>" as any,
      );
      const { handleConsumerHtml } = await import("./consumer-html.js");
      const req = mockReq("");
      const res = mockRes();

      handleConsumerHtml(req, res);

      const csp = res._headers["Content-Security-Policy"] as string;
      expect(csp).toContain("script-src 'none'");
      expect(csp).toContain("style-src 'none'");
    });
  });

  describe("injectConsumerToken", () => {
    it("adds a meta tag with the consumer token", async () => {
      const { injectConsumerToken, loadConsumerHtml } = await import("./consumer-html.js");

      injectConsumerToken("test-key-123");
      const html = loadConsumerHtml();

      expect(html).toContain('<meta name="beamcode-consumer-token" content="test-key-123">');
    });

    it("escapes special HTML characters in the token", async () => {
      const { injectConsumerToken, loadConsumerHtml } = await import("./consumer-html.js");

      injectConsumerToken('<script>"alert&xss"</script>');
      const html = loadConsumerHtml();

      // Verify characters are escaped
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("&quot;");
      expect(html).toContain("&amp;");
      expect(html).not.toContain('content="<script>');
    });

    it("recomputes gzip and CSP after injection", async () => {
      const { handleConsumerHtml, injectConsumerToken } = await import("./consumer-html.js");

      injectConsumerToken("my-key");

      const req = mockReq("gzip");
      const res = mockRes();
      handleConsumerHtml(req, res);

      // Verify gzip body can be decompressed to HTML containing the meta tag
      const { gunzipSync } = await import("node:zlib");
      const decompressed = gunzipSync(res._body as Buffer).toString();
      expect(decompressed).toContain('<meta name="beamcode-consumer-token" content="my-key">');
    });
  });

  describe("injectConsumerAuthTokens", () => {
    it("injects both API and consumer token meta tags", async () => {
      const { injectConsumerAuthTokens, loadConsumerHtml } = await import("./consumer-html.js");

      injectConsumerAuthTokens({
        apiToken: "api-key-123",
        consumerToken: "ws-key-456",
      });
      const html = loadConsumerHtml();

      expect(html).toContain('<meta name="beamcode-api-token" content="api-key-123">');
      expect(html).toContain('<meta name="beamcode-consumer-token" content="api-key-123">');
      expect(html).toContain('<meta name="beamcode-ws-token" content="ws-key-456">');
    });

    it("updates existing injected tags instead of duplicating stale values", async () => {
      const { injectConsumerAuthTokens, loadConsumerHtml } = await import("./consumer-html.js");

      injectConsumerAuthTokens({
        apiToken: "api-old",
        consumerToken: "ws-old",
      });
      injectConsumerAuthTokens({
        apiToken: "api-new",
        consumerToken: "ws-new",
      });

      const html = loadConsumerHtml();
      expect(html).toContain('<meta name="beamcode-api-token" content="api-new">');
      expect(html).toContain('<meta name="beamcode-consumer-token" content="api-new">');
      expect(html).toContain('<meta name="beamcode-ws-token" content="ws-new">');
      expect(html).not.toContain("api-old");
      expect(html).not.toContain("ws-old");
    });
  });
});
