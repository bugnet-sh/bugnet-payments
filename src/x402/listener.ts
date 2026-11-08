import { createPrivateKey, X509Certificate } from "node:crypto";
import { createSecureServer, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import type { ServiceImpl } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { X402SignerService } from "../gen/bugnet/payments/v1/x402_pb.ts";
import { splitListen } from "../http/server.ts";
import type { Log } from "../log.ts";
import type { SignerHealth } from "./types.ts";

export const SERVER_NAME = "bugnet-payments.internal";

export interface TlsFiles {
    certPem: string;
    keyPem: string;
    caPem: string;
}

export type TlsCheck =
    { ok: true; serverNotAfter: Date; caNotAfter: Date } | { ok: false; problem: string };

function parseCert(pem: string): X509Certificate | null {
    try {
        return new X509Certificate(pem);
    } catch {
        return null;
    }
}

// Problems never carry key text: they reach the alarm log
export function checkTlsFiles(f: TlsFiles, serverName: string, now: Date): TlsCheck {
    const cert = parseCert(f.certPem);
    if (!cert) return { ok: false, problem: "tls_cert_file does not parse" };
    let key;
    try {
        key = createPrivateKey(f.keyPem);
    } catch {
        return { ok: false, problem: "BUGNET_X402_TLS_KEY does not parse" };
    }
    if (!cert.checkPrivateKey(key)) {
        return { ok: false, problem: "BUGNET_X402_TLS_KEY does not match tls_cert_file" };
    }
    if (cert.checkHost(serverName, { subject: "never", wildcards: false }) === undefined) {
        return { ok: false, problem: `tls_cert_file does not name ${serverName}` };
    }
    const ca = parseCert(f.caPem);
    if (!ca) return { ok: false, problem: "client_ca_file does not parse" };
    const serverNotAfter = cert.validToDate;
    const caNotAfter = ca.validToDate;
    if (now > serverNotAfter) return { ok: false, problem: "tls_cert_file expired" };
    if (now > caNotAfter) return { ok: false, problem: "client_ca_file expired" };
    return { ok: true, serverNotAfter, caNotAfter };
}

export type LiveCheckName = "token_account" | "tls";

interface CheckState {
    result: "pass" | "fail";
    lastPassAt: Date | null;
    lastWasError: boolean;
}

const CHECKS: readonly LiveCheckName[] = ["token_account", "tls"];

export class SignerGate implements SignerHealth {
    private readonly state = new Map<LiveCheckName, CheckState>();
    private wasDown = false;
    private readonly downListeners: Array<() => void> = [];

    constructor(private readonly o: { staleAfterMs: number; log: Log; now: () => Date }) {}

    record(check: LiveCheckName, result: "pass" | "fail" | "error", detail?: string): void {
        const s = this.state.get(check) ?? {
            result: "fail",
            lastPassAt: null,
            lastWasError: false,
        };
        if (result === "pass") {
            s.result = "pass";
            s.lastPassAt = this.o.now();
            s.lastWasError = false;
        } else if (result === "fail") {
            s.result = "fail";
            s.lastWasError = false;
        } else {
            s.lastWasError = true;
        }
        this.state.set(check, s);
        this.evaluate(check, detail);
    }

    onDown(cb: () => void): void {
        this.downListeners.push(cb);
    }

    open(): boolean {
        this.evaluate();
        return CHECKS.every((c) => this.state.has(c)) && !this.down();
    }

    private down(): boolean {
        const now = this.o.now().getTime();
        for (const s of this.state.values()) {
            if (s.result === "fail") return true;
            if (
                s.lastWasError &&
                (s.lastPassAt === null || now - s.lastPassAt.getTime() > this.o.staleAfterMs)
            ) {
                return true;
            }
        }
        return false;
    }

    private evaluate(check?: LiveCheckName, detail?: string): void {
        const down = this.down();
        const was = this.wasDown;
        if (down && !was) this.o.log.alarm("x402_signer_down", { check, detail });
        this.wasDown = down;
        if (down && !was) for (const cb of this.downListeners) cb();
    }
}

export interface SignerListener {
    port: number;
    reload(f: TlsFiles): boolean;
    // The files the TLS stack serves now: the ones it started with or last reloaded
    loaded(): TlsFiles;
    lastClientCertNotAfter(): Date | null;
    close(): Promise<void>;
}

const TLS13 = { minVersion: "TLSv1.3", maxVersion: "TLSv1.3" } as const;

export async function startSignerListener(o: {
    listen: string;
    files: TlsFiles;
    clientName: string;
    gate: SignerHealth;
    service: Partial<ServiceImpl<typeof X402SignerService>>;
    log: Log;
}): Promise<SignerListener> {
    const sessions = new Set<ServerHttp2Session>();
    const dropSessions = () => {
        for (const s of sessions) s.destroy();
    };
    o.gate.onDown?.(dropSessions);
    // A session opened while the gate was open must not outlive it, so every call checks again
    const guarded = <A extends unknown[], Res>(fn: ((...a: A) => Res | Promise<Res>) | undefined) =>
        fn &&
        (async (...args: A): Promise<Res> => {
            if (!o.gate.open()) {
                setImmediate(dropSessions);
                throw new ConnectError("x402 signer is closed", Code.Unavailable);
            }
            return await fn(...args);
        });
    const service = {
        reserveAndSign: guarded(o.service.reserveAndSign),
        reportOutcome: guarded(o.service.reportOutcome),
    } as Partial<ServiceImpl<typeof X402SignerService>>;
    const server = createSecureServer(
        {
            cert: o.files.certPem,
            key: o.files.keyPem,
            ca: o.files.caPem,
            requestCert: true,
            rejectUnauthorized: true,
            ...TLS13,
            allowHTTP1: false,
        },
        connectNodeAdapter({ routes: (r) => r.service(X402SignerService, service) }),
    );
    let clientNotAfter: Date | null = null;
    let loaded = o.files;
    // Runs before http2 makes a session, so a refused peer never reaches the service
    server.prependListener("secureConnection", (socket) => {
        const peer = socket.getPeerX509Certificate();
        if (
            !o.gate.open() ||
            !peer ||
            peer.checkHost(o.clientName, { subject: "never", wildcards: false }) === undefined
        ) {
            socket.destroy();
            return;
        }
        clientNotAfter = peer.validToDate;
    });
    server.on("session", (s: ServerHttp2Session) => {
        sessions.add(s);
        s.once("close", () => sessions.delete(s));
    });
    const { host, port } = splitListen(o.listen);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });
    return {
        port: (server.address() as AddressInfo).port,
        reload(f) {
            const check = checkTlsFiles(f, SERVER_NAME, new Date());
            if (!check.ok) {
                o.log.alarm("x402_reload_failed", { file: "x402 tls", problem: check.problem });
                return false;
            }
            try {
                server.setSecureContext({ cert: f.certPem, key: f.keyPem, ca: f.caPem, ...TLS13 });
            } catch {
                o.log.alarm("x402_reload_failed", {
                    file: "x402 tls",
                    problem: "tls files rejected by the TLS stack",
                });
                return false;
            }
            loaded = f;
            return true;
        },
        loaded: () => loaded,
        lastClientCertNotAfter: () => clientNotAfter,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                dropSessions();
            }),
    };
}

export function certExpiryAlarm(o: {
    serverNotAfter: Date;
    caNotAfter: Date;
    clientNotAfter: Date | null;
    beforeMs: number;
    now: Date;
    log: Log;
}): boolean {
    const within = (d: Date) => d.getTime() - o.now.getTime() <= o.beforeMs;
    const expiring: string[] = [];
    if (within(o.serverNotAfter)) expiring.push("server");
    if (within(o.caNotAfter)) expiring.push("ca");
    if (o.clientNotAfter && within(o.clientNotAfter)) expiring.push("client");
    if (expiring.length === 0) return false;
    o.log.alarm("x402_cert_expiry", {
        expiring,
        serverNotAfter: o.serverNotAfter,
        caNotAfter: o.caNotAfter,
        clientNotAfter: o.clientNotAfter,
    });
    return true;
}
