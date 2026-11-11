import { describe, expect, it } from "vitest";
import {
    checkRpcList,
    domainOf,
    endpointName,
    MAX_RPC_URLS,
    parseRpcUrls,
    type RpcSettings,
    resolveRpcList,
    rpcSettingsSchema,
    urlSecretParts,
} from "./settings.ts";

const defaults: RpcSettings = rpcSettingsSchema.parse({});
const SHELL = "holds a shell character (& ; | < > ( ) $ ` ' \" \\)";
const HTTPS = "must be an https URL (http only on a loopback host)";

function problemsOf(value: string): string[] {
    return parseRpcUrls(value).problems;
}

describe("parseRpcUrls", () => {
    it("parseRpcUrls keeps the order", () => {
        const r = parseRpcUrls(
            "https://a.example/?api-key=k1, https://b.example/v2/k2 ,https://c.example,",
        );
        expect(r.urls).toEqual([
            "https://a.example/?api-key=k1",
            "https://b.example/v2/k2",
            "https://c.example",
        ]);
        expect(r.problems).toEqual([]);
    });

    it("list problems name positions only", () => {
        const seven = Array.from({ length: 7 }, (_, i) => `https://n${i}.example`).join(",");
        const cases: [string, string][] = [
            ["https://a.example,http://b.example", `rpc2 ${HTTPS}`],
            ["https://a.example,nope", "rpc2 is not a URL"],
            ["https://u:p@a.example", "rpc1 must not hold a user or password"],
            ["https://a.example/k # note", "rpc1 must not contain whitespace"],
            ["https://a.example/?k=1,https://a.example/?k=1", "rpc2 is the same URL as rpc1"],
            ["https://a.example,https://a.example/", "rpc2 is the same URL as rpc1"],
            [" , ,", "lists no URL"],
            [seven, "lists 7 URLs, at most 6"],
        ];
        for (const [value, problem] of cases) {
            const problems = problemsOf(value);
            expect(problems, value).toEqual([problem]);
            for (const part of ["a.example", "b.example", "k1", "nope", "u:p"]) {
                expect(problems.join("; ")).not.toContain(part);
            }
        }
        expect(MAX_RPC_URLS).toBe(6);
    });

    it("a list item with a shell character is refused", () => {
        expect(problemsOf("https://a.example,https://b.example/?x=1&k=2")).toEqual([
            `rpc2 ${SHELL}`,
        ]);
        for (const ch of [";", "|", "<", ">", "(", ")", "$", "`", "'", '"', "\\"]) {
            const problems = problemsOf(`https://a.example,https://b.example/?x=1${ch}k=2`);
            expect(problems, ch).toEqual([`rpc2 ${SHELL}`]);
            expect(problems.join("; ")).not.toContain("b.example");
            expect(problems.join("; ")).not.toContain("k=2");
        }
    });

    it("a comma inside a URL splits it", () => {
        expect(problemsOf("https://a.example/?ids=1,2")).toEqual(["rpc2 is not a URL"]);
        expect(parseRpcUrls("https://a.example/?ids=1%2C2")).toEqual({
            urls: ["https://a.example/?ids=1%2C2"],
            problems: [],
        });
    });

    it("loopback http is allowed", () => {
        const loopback = "http://127.0.0.1:8899,http://localhost:8900,http://[::1]:8901";
        expect(parseRpcUrls(loopback)).toEqual({ urls: loopback.split(","), problems: [] });
        expect(problemsOf("http://127.0.0.1.nip.io")).toEqual([`rpc1 ${HTTPS}`]);
    });
});

describe("endpointName", () => {
    it("names an endpoint by its position", () => {
        expect(endpointName(0)).toBe("rpc1");
        expect(endpointName(2)).toBe("rpc3");
    });
});

describe("domainOf", () => {
    it("domainOf", () => {
        expect(domainOf("https://one.x.example/?api-key=k1")).toBe("x.example");
        expect(domainOf("https://two.x.example/v2/k2")).toBe("x.example");
        expect(domainOf("https://b.example")).toBe("b.example");
        expect(domainOf("http://127.0.0.1:8899")).toBe("127.0.0.1:8899");
    });
});

describe("urlSecretParts", () => {
    it("urlSecretParts", () => {
        expect(urlSecretParts("https://plain.example")).toEqual(["plain.example"]);
        expect(urlSecretParts("https://x.example/v2/abcdefghijklmnop1234")).toEqual([
            "abcdefghijklmnop1234",
            "x.example",
        ]);
        expect(
            urlSecretParts("https://x.example/?api-key=0123456789abcdef0123&cluster=main"),
        ).toEqual(["0123456789abcdef0123", "x.example"]);
    });

    it("gives nothing for an item that is not a URL", () => {
        expect(urlSecretParts("nope")).toEqual([]);
    });
});

describe("resolveRpcList and checkRpcList", () => {
    const three = ["https://a.example/", "https://b.example/", "https://c.example/"];
    const sameDomain = ["https://one.x.example/", "https://two.x.example/"];

    it("the quorum and copies resolve from the domains", () => {
        expect(resolveRpcList(defaults, three)).toEqual({
            domains: 3,
            absenceQuorum: 2,
            sendFanout: 1,
        });
        expect(resolveRpcList(defaults, sameDomain)).toEqual({
            domains: 1,
            absenceQuorum: 1,
            sendFanout: 0,
        });
        expect(resolveRpcList(defaults, ["https://a.example/"])).toEqual({
            domains: 1,
            absenceQuorum: 1,
            sendFanout: 0,
        });
        expect(resolveRpcList({ ...defaults, absence_quorum: 1 }, three)).toMatchObject({
            absenceQuorum: 1,
        });
    });

    it("an explicit quorum needs that many domains", () => {
        expect(checkRpcList({ ...defaults, absence_quorum: 2 }, 10_000, sameDomain)).toEqual([
            "solana.rpc.absence_quorum: 2 needs URLs on 2 different domains in BUGNET_SOLANA_RPC_URLS, found 1",
        ]);
        expect(checkRpcList({ ...defaults, absence_quorum: 2 }, 10_000, three)).toEqual([]);
    });

    it("an explicit send_fanout needs other domains", () => {
        expect(
            checkRpcList({ ...defaults, send_fanout: 1 }, 10_000, ["https://a.example/"]),
        ).toEqual(["solana.rpc.send_fanout: 1 needs URLs on 2 different domains, found 1"]);
        expect(checkRpcList({ ...defaults, send_fanout: 1 }, 10_000, three)).toEqual([]);
    });

    it("attempts fit in rpc_timeout with two or more URLs", () => {
        const rpc = (attempt: string) =>
            rpcSettingsSchema.parse({ attempt_timeout: attempt, max_attempts: 3 });
        const two = ["https://a.example/", "https://b.example/"];
        expect(checkRpcList(rpc("4s"), 10_000, two)).toEqual([
            "solana.rpc.attempt_timeout: times max_attempts must be at most solana.rpc_timeout",
        ]);
        expect(checkRpcList(rpc("3s"), 10_000, two)).toEqual([]);
        expect(checkRpcList(rpc("4s"), 1_000, ["https://a.example/"])).toEqual([]);
    });
});
