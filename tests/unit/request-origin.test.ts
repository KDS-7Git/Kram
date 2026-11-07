import { describe, expect, it } from "vitest";
import { isAllowedRequestOrigin } from "../../apps/api/src/request-origin";

const policy = { appUrl: "https://planner.example.test", production: true };
const allow = (origin: string, host?: string, encrypted = false) => isAllowedRequestOrigin(origin, host, encrypted, policy);

describe("direct local app origins", () => {
  it.each([
    "localhost:8420", "127.0.0.1:8420", "127.0.0.2:9100", "[::1]:8420",
    "192.168.1.20:8420", "192.168.50.21:9100", "10.20.30.40:8420",
    "172.16.0.1:8420", "172.31.255.254:8420", "169.254.1.20:8420",
    "100.64.0.1:8420", "100.127.255.254:8420", "[fd12:3456::20]:8420",
    "[fc00::20]:8420", "[fe80::20]:8420", "[::ffff:c0a8:114]:8420",
  ])("accepts direct local access to %s without changing the configured URL", host => {
    expect(allow(`http://${host}`, host)).toBe(true);
  });

  it("uses the external request port, including default HTTP/HTTPS ports", () => {
    expect(allow("http://localhost", "localhost:80")).toBe(true);
    expect(allow("https://localhost", "localhost:443", true)).toBe(true);
    expect(allow("http://localhost:9100", "localhost:8420")).toBe(false);
  });

  it("requires the actual host and socket scheme to match", () => {
    expect(allow("http://localhost:8420", "192.168.1.20:8420")).toBe(false);
    expect(allow("http://192.168.1.21:8420", "192.168.1.20:8420")).toBe(false);
    expect(allow("https://192.168.1.20:8420", "192.168.1.20:8420")).toBe(false);
    expect(allow("http://localhost:8420", "localhost:8420", true)).toBe(false);
    expect(allow("https://localhost:8420", "localhost:8420", true)).toBe(true);
  });

  it.each([
    "evil.example.test:8420", "localhost.evil.example.test:8420", "localhost.:8420",
    "203.0.113.20:8420", "172.15.255.254:8420", "172.32.0.1:8420",
    "192.169.1.20:8420", "100.63.255.254:8420", "100.128.0.1:8420",
    "0.0.0.0:8420", "[::]:8420", "[2001:db8::20]:8420", "[::ffff:cb00:7114]:8420",
  ])("does not automatically trust %s even with a matching Host", host => {
    expect(allow(`http://${host}`, host)).toBe(false);
  });

  it.each([
    "null", "", "http://localhost:8420/", "http://localhost:8420/path",
    "http://user@localhost:8420", "http://localhost:8420?x=1", "http://localhost:8420#x",
    "http://localhost:8420, https://evil.example.test", " http://localhost:8420",
    "http://LOCALHOST:8420", "ftp://localhost:8420",
  ])("rejects malformed or decorated Origin %j", origin => {
    expect(allow(origin, "localhost:8420")).toBe(false);
  });

  it.each([
    undefined, "", "localhost:8420/path", "user@localhost:8420", "localhost:8420?x=1",
    "localhost:8420#x", "localhost:8420,evil.test", "localhost:8420\\path", "local%68ost:8420",
  ])("rejects invalid direct Host %j", host => {
    expect(allow("http://localhost:8420", host)).toBe(false);
  });

  it("retains configured proxy origins and development Vite access", () => {
    expect(allow("https://planner.example.test", "app:8420")).toBe(true);
    expect(allow("http://localhost:5173", "127.0.0.1:8420")).toBe(false);
    expect(isAllowedRequestOrigin("http://localhost:5173", "127.0.0.1:8420", false, { ...policy, production: false })).toBe(true);
  });
});
