import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect as h2Connect, type ClientHttp2Session } from "node:http2";
import { connect as tlsConnect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { X402SignerService } from "../gen/bugnet/payments/v1/x402_pb.ts";
import { memoryLog } from "../log.ts";
import { makeTestPki } from "../testing/pki.ts";
import {
    certExpiryAlarm,
    checkTlsFiles,
    SERVER_NAME,
    SignerGate,
    startSignerListener,
    type SignerListener,
    type TlsFiles,
} from "./listener.ts";

const T0 = new Date("2030-01-01T12:00:00Z");
const DAY = 86_400_000;
let dir: string;
let pki: ReturnType<typeof makeTestPki>;
let files: TlsFiles;
let log: ReturnType<typeof memoryLog>;
let calls: string[];
let listeners: SignerListener[];

const pem = (path: string) => readFileSync(path, "utf8");

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "bn-pki-"));
    pki = makeTestPki(dir);
    files = { certPem: pem(pki.serverCert), keyPem: pem(pki.serverKey), caPem: pem(pki.ca) };
});
afterAll(async () => {
    for (const l of listeners) await l.close();
    rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
    for (const l of listeners ?? []) await l.close();
    listeners = [];
    calls = [];
    log = memoryLog();
});

async function listen(gateOpen: () => boolean = () => true): Promise<SignerListener> {
    const l = await startSignerListener({
        listen: "127.0.0.1:0",
        files,
        clientName: "bugnet-egress.internal",
        gate: { open: gateOpen },
        service: {
            async reserveAndSign(req) {
                calls.push(req.ref);
                return { result: { case: "refused", value: { reason: "x402_disabled" } } };
            },
        },
        log,
    });
    listeners.push(l);
    return l;
}
function client(port: number, o: { cert?: string; key?: string; maxVersion?: "TLSv1.2" } = {}) {
    return createClient(
        X402SignerService,
        createConnectTransport({
            baseUrl: `https://127.0.0.1:${port}`,
            httpVersion: "2",
            defaultTimeoutMs: 3_000,
            nodeOptions: {
                ca: files.caPem,
                cert: o.cert === undefined ? undefined : pem(o.cert),
                key: o.key === undefined ? undefined : pem(o.key),
                servername: SERVER_NAME,
                maxVersion: o.maxVersion,
            },
        }),
    );
}
function egress(port: number) {
    return client(port, { cert: pki.clientCert, key: pki.clientKey });
}
function peerFingerprint(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const s = tlsConnect({
            host: "127.0.0.1",
            port,
            ca: files.caPem,
            cert: pem(pki.clientCert),
            key: pem(pki.clientKey),
            servername: SERVER_NAME,
            ALPNProtocols: ["h2"],
        });
        s.once("secureConnect", () => {
            resolve(s.getPeerX509Certificate()!.fingerprint256);
            s.destroy();
        });
        s.once("error", reject);
    });
}
function rawSession(port: number): Promise<ClientHttp2Session> {
    return new Promise((resolve, reject) => {
        const s = h2Connect(`https://127.0.0.1:${port}`, {
            ca: files.caPem,
            cert: pem(pki.clientCert),
            key: pem(pki.clientKey),
            servername: SERVER_NAME,
        });
        s.once("connect", () => resolve(s));
        s.once("error", reject);
    });
}
function rawCall(s: ClientHttp2Session, method: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = s.request({
            ":method": "POST",
            ":path": `/bugnet.payments.v1.X402SignerService/${method}`,
            "content-type": "application/json",
            "connect-protocol-version": "1",
        });
        req.on("response", (h) => resolve(Number(h[":status"])));
        req.on("error", reject);
        req.end("{}");
        req.resume();
    });
}
const closed = (s: ClientHttp2Session) =>
    s.closed || s.destroyed
        ? Promise.resolve()
        : new Promise<void>((r) => s.once("close", () => r()));
function alarms(name: string) {
    return log.lines.filter((l) => l.alarm === name);
}

describe("startSignerListener", () => {
    it("accepts the egress certificate", async () => {
        const l = await listen();
        const res = await egress(l.port).reserveAndSign({ ref: "abcdefghijklmnop" });
        expect(res.result.case).toBe("refused");
        expect(calls).toEqual(["abcdefghijklmnop"]);
        expect(l.lastClientCertNotAfter()).toEqual(
            new X509Certificate(pem(pki.clientCert)).validToDate,
        );
    });

    it("refuses a client certificate with another name", async () => {
        const l = await listen();
        const other = client(l.port, { cert: pki.otherClientCert, key: pki.otherClientKey });
        await expect(other.reserveAndSign({ ref: "abcdefghijklmnop" })).rejects.toThrow();
        expect(calls).toEqual([]);
    });

    it("refuses a client with no certificate", async () => {
        const l = await listen();
        await expect(client(l.port).reserveAndSign({ ref: "abcdefghijklmnop" })).rejects.toThrow();
        expect(calls).toEqual([]);
    });

    it("refuses TLS 1.2", async () => {
        const l = await listen();
        const old = client(l.port, {
            cert: pki.clientCert,
            key: pki.clientKey,
            maxVersion: "TLSv1.2",
        });
        await expect(old.reserveAndSign({ ref: "abcdefghijklmnop" })).rejects.toThrow();
        expect(calls).toEqual([]);
    });

    it("a closed gate refuses connections; an open gate accepts", async () => {
        let open = false;
        const l = await listen(() => open);
        await expect(egress(l.port).reserveAndSign({ ref: "abcdefghijklmnop" })).rejects.toThrow();
        expect(calls).toEqual([]);
        open = true;
        expect((await egress(l.port).reserveAndSign({ ref: "abcdefghijklmnop" })).result.case).toBe(
            "refused",
        );
    });

    it("refuses a client certificate named only by a wildcard", async () => {
        const l = await listen();
        const wild = client(l.port, { cert: pki.wildClientCert, key: pki.wildClientKey });
        await expect(wild.reserveAndSign({ ref: "abcdefghijklmnop" })).rejects.toThrow();
        expect(calls).toEqual([]);
    });

    it("answers Unavailable on an open session once the gate closes, then destroys it", async () => {
        let open = true;
        const l = await listen(() => open);
        const s = await rawSession(l.port);
        expect(await rawCall(s, "ReserveAndSign")).toBe(200);
        open = false;
        expect(await rawCall(s, "ReserveAndSign")).toBe(503);
        expect(await rawCall(s, "ReportOutcome").catch(() => 503)).toBe(503);
        await closed(s);
        expect(s.destroyed || s.closed).toBe(true);
        expect(calls).toEqual([""]);
    });

    it("destroys open sessions when a real gate goes down", async () => {
        const gate = new SignerGate({ staleAfterMs: 120_000, log, now: () => T0 });
        gate.record("tls", "pass");
        gate.record("token_account", "pass");
        const l = await startSignerListener({
            listen: "127.0.0.1:0",
            files,
            clientName: "bugnet-egress.internal",
            gate,
            service: {},
            log,
        });
        listeners.push(l);
        const s = await rawSession(l.port);
        gate.record("token_account", "fail");
        await closed(s);
        expect(s.destroyed || s.closed).toBe(true);
    });

    it("reload with a broken later certificate block alarms and returns false", async () => {
        const l = await listen();
        const broken = `${files.certPem}\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n`;
        expect(l.reload({ ...files, certPem: broken })).toBe(false);
        expect(alarms("x402_reload_failed")).toHaveLength(1);
        expect((await egress(l.port).reserveAndSign({ ref: "abcdefghijklmnop" })).result.case).toBe(
            "refused",
        );
    });

    it("still refuses TLS 1.2 after a successful reload", async () => {
        const l = await listen();
        expect(l.reload(files)).toBe(true);
        const old = client(l.port, {
            cert: pki.clientCert,
            key: pki.clientKey,
            maxVersion: "TLSv1.2",
        });
        await expect(old.reserveAndSign({ ref: "abcdefghijklmnop" })).rejects.toThrow();
        expect(calls).toEqual([]);
    });

    it("reload keeps the old files on a bad file and alarms", async () => {
        const l = await listen();
        const before = await peerFingerprint(l.port);
        expect(l.loaded()).toEqual(files);
        expect(l.reload({ ...files, certPem: "garbage" })).toBe(false);
        expect(l.loaded()).toEqual(files);
        expect(alarms("x402_reload_failed")).toHaveLength(1);
        expect(await peerFingerprint(l.port)).toBe(before);
        const renewed = { ...files, certPem: `${files.certPem}\n` };
        expect(l.reload(renewed)).toBe(true);
        expect(l.loaded()).toEqual(renewed);
        expect(alarms("x402_reload_failed")).toHaveLength(1);
        expect((await egress(l.port).reserveAndSign({ ref: "abcdefghijklmnop" })).result.case).toBe(
            "refused",
        );
    });
});

describe("SignerGate", () => {
    it("is closed until both checks pass, with no alarm", () => {
        const g = new SignerGate({ staleAfterMs: 120_000, log, now: () => T0 });
        expect(g.open()).toBe(false);
        g.record("token_account", "pass");
        expect(g.open()).toBe(false);
        g.record("tls", "pass");
        expect(g.open()).toBe(true);
        expect(alarms("x402_signer_down")).toHaveLength(0);
    });

    it("the gate keeps the last result through errors until stale", () => {
        let t = T0;
        const g = new SignerGate({ staleAfterMs: 120_000, log, now: () => t });
        g.record("tls", "pass");
        g.record("token_account", "pass");
        t = new Date(T0.getTime() + 60_000);
        g.record("token_account", "error");
        expect(g.open()).toBe(true);
        t = new Date(T0.getTime() + 121_000);
        g.record("token_account", "error");
        expect(g.open()).toBe(false);
        expect(g.open()).toBe(false);
        expect(alarms("x402_signer_down")).toHaveLength(1);
    });

    it("a fail closes at once, alarms once, and a pass reopens", () => {
        const g = new SignerGate({ staleAfterMs: 120_000, log, now: () => T0 });
        g.record("tls", "pass");
        g.record("token_account", "fail", "delegate set");
        g.record("token_account", "fail", "delegate set");
        expect(g.open()).toBe(false);
        expect(alarms("x402_signer_down")).toEqual([
            expect.objectContaining({ check: "token_account", detail: "delegate set" }),
        ]);
        g.record("token_account", "pass");
        expect(g.open()).toBe(true);
        g.record("token_account", "fail");
        expect(alarms("x402_signer_down")).toHaveLength(2);
    });

    it("a check recorded once at boot never goes stale while nothing errors", () => {
        let t = T0;
        const g = new SignerGate({ staleAfterMs: 120_000, log, now: () => t });
        g.record("tls", "pass");
        g.record("token_account", "pass");
        t = new Date(T0.getTime() + 10 * 60_000);
        g.record("token_account", "pass");
        expect(g.open()).toBe(true);
    });
});

describe("checkTlsFiles", () => {
    it("passes the server pair and gives both expiries", () => {
        const r = checkTlsFiles(files, SERVER_NAME, new Date());
        expect(r).toEqual({
            ok: true,
            serverNotAfter: new X509Certificate(files.certPem).validToDate,
            caNotAfter: new X509Certificate(files.caPem).validToDate,
        });
    });

    it("refuses a mismatched pair, a wrong SAN and an expired certificate", () => {
        const now = new Date();
        const mismatched = checkTlsFiles(
            { ...files, keyPem: pem(pki.clientKey) },
            SERVER_NAME,
            now,
        );
        expect(mismatched).toEqual({
            ok: false,
            problem: "BUGNET_X402_TLS_KEY does not match tls_cert_file",
        });
        const wrongSan = checkTlsFiles(
            { certPem: pem(pki.clientCert), keyPem: pem(pki.clientKey), caPem: files.caPem },
            SERVER_NAME,
            now,
        );
        expect(wrongSan).toEqual({
            ok: false,
            problem: "tls_cert_file does not name bugnet-payments.internal",
        });
        const notAfter = new X509Certificate(files.certPem).validToDate;
        const expired = checkTlsFiles(files, SERVER_NAME, new Date(notAfter.getTime() + 1_000));
        expect(expired).toEqual({ ok: false, problem: "tls_cert_file expired" });
        expect(JSON.stringify([mismatched, wrongSan, expired])).not.toContain("PRIVATE KEY");
    });
});

describe("certExpiryAlarm", () => {
    const base = {
        caNotAfter: new Date(T0.getTime() + 3650 * DAY),
        beforeMs: 2_592_000_000,
        now: T0,
    };

    it("certExpiryAlarm fires within 720 hours", () => {
        const at = (days: number) => new Date(T0.getTime() + days * DAY);
        expect(
            certExpiryAlarm({ ...base, serverNotAfter: at(29), clientNotAfter: null, log }),
        ).toBe(true);
        expect(alarms("x402_cert_expiry")).toEqual([
            expect.objectContaining({ expiring: ["server"] }),
        ]);
        expect(
            certExpiryAlarm({ ...base, serverNotAfter: at(31), clientNotAfter: null, log }),
        ).toBe(false);
        expect(
            certExpiryAlarm({ ...base, serverNotAfter: at(31), clientNotAfter: at(10), log }),
        ).toBe(true);
        expect(alarms("x402_cert_expiry")).toHaveLength(2);
        expect(alarms("x402_cert_expiry")[1]).toMatchObject({ expiring: ["client"] });
    });
});
